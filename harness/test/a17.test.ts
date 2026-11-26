import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseRange,rangeKey } from '../src/queue/range.ts';
import { parseRangeLite } from '../src/job/runner.ts';
import { scopeText } from '../src/research/prompts/common.ts';
import { verifyCandidates,loadSource } from '../src/research/identify/decide.ts';
import { identify,resolvePickedWork } from '../src/research/identify/index.ts';
import { fixtureNkg,fixtureMeta } from '../src/nkg/testFixtures.ts';
import { validateNkg } from '../src/nkg/validate.ts';
import { buildProjection } from '../src/gen/project.ts';
import { checkPublicWork } from '../src/gen/check.ts';
import { evaluateConformance,parseConformanceConfig } from '../src/check/conformance.ts';
import { bookWorkBody,bookPageBody } from '../../site/src/book.ts';
import { hasSubpage } from '../../site/src/templates.ts';
import { strictSchemaViolations } from '../src/model/validate.ts';
import { PAGE_MENU_SCHEMA } from '../src/nkg/bookSelection.ts';
import { BOOK_WRITE_SCHEMA } from '../src/gen/book.ts';
import { writeBookPages } from '../src/gen/book.ts';
import { genContext } from '../src/gen/testFixtures.ts';
import { selectModules } from '../src/nkg/modules.ts';
import { fixtureContext,makeFixtureWork,cannedS2 } from '../src/nkg/testWork.ts';
import { fakePort } from '../src/nkg/testFixtures.ts';
import { BOOK_GROUPS,SPECS,groupSchema } from '../src/nkg/elements.ts';
import type { SourceCard } from '../src/research/types.ts';
import { recheckPublic } from '../src/check/stage.ts';
import { basePublic } from './fixtures/m3/planted.ts';

test('A17: part/chapter/section ranges, kanji, intervals and scopeText share A16 grammar',()=>{
  for(const [raw,unit,a,b] of [['第ニ章','chapter',2,2],['第2部','part',2,2],['第十二章〜第十五章','chapter',12,15],['第3節','section',3,3],['1-3章','chapter',1,3]] as const){
    const text=raw.replace('ニ','二'),r=parseRange(text);assert.equal(r.ok,true);
    if(!r.ok)throw Error('range parse failed');
    assert.deepEqual(r.items[0],{unit,from:a,to:b,label:a===b?`${a}${unit==='part'?'部':unit==='chapter'?'章':'節'}`:`${a}-${b}章`});
    assert.deepEqual(parseRangeLite(text),r.items);assert.ok(scopeText(r.items)?.includes(r.items[0].label));
  }
  assert.equal(parseRange('第0章').ok,false);assert.equal(parseRange('第3章〜第1章').ok,false);
  const r=parseRange('第1部、第2章、第3節');assert.ok(r.ok);assert.equal(rangeKey(r.items),'part:1-1,chapter:2-2,section:3-3');
});

test('A17: kind evidence is verified independently; book never defaults to fiction',()=>{
  const card={source_id:'s1',tier:'T1'} as SourceCard;
  const sources=new Map([['s1',loadSource(card,'書名：試験書。これは科学の一般向けノンフィクションです。')]]);
  const base={title:'試験書',title_original:null,title_reading:'しけんしょ',medium:'book' as const,creators:[],first_release_year:2026,evidence:[{source_id:'s1',quote:'書名：試験書'}],aliases_seen:[]};
  assert.equal(verifyCandidates([base],sources).kept[0].kind,null);
  const c={...base,kind:'nonfiction' as const,kind_reason:'科学の一般書と明記',kind_evidence:[{source_id:'s1',quote:'一般向けノンフィクション'}]};
  assert.equal(verifyCandidates([c],sources).kept[0].kind,'nonfiction');
  assert.equal(verifyCandidates([{...c,kind_evidence:[{source_id:'s1',quote:'存在しない根拠'}]}],sources).kept[0].kind,null);
});

test('A17: legacy unknown kind stays clarifying even on an index match',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sfsh-a17-id-'));const wid='novel-unknown-2000';
  fs.mkdirSync(path.join(root,wid));fs.writeFileSync(path.join(root,wid,'work.json'),JSON.stringify({work_id:wid,title:'不明書',medium:'novel',first_release_year:2000,creators:[],aliases:[]}));
  fs.writeFileSync(path.join(root,'INDEX.json'),JSON.stringify({works:[{work_id:wid,title:'不明書',medium:'novel',aliases:[]}]}));
  const r=resolvePickedWork({jobId:'a17',workQuery:'不明書',mediumHint:null},wid,{worksDir:root,now:()=>new Date(),log:()=>{}});
  assert.equal(r.status,'clarifying');assert.equal(r.reason,'kind_unknown');
});

test('A17: BKG keeps kernel provenance, public projection, stance, diagrams and selected-only conformance',()=>{
  const nkg=fixtureNkg();nkg.work.kind='nonfiction';nkg.work.medium='book';
  nkg.work.module_selection=[{module:'B01',enabled:true,weight:1,reason:'thesis'},{module:'B02',enabled:true,weight:1,reason:'argument'},{module:'B03',enabled:true,weight:1,reason:'concept'}];
  const meta=fixtureMeta(['s000000001']);
  nkg.nodes=[{id:'bt01',type:'Thesis',module:'B01',label:'中心命題',summary:'著者は技術と判断の関係を論じます。',based_on:[],meta,stance:'author_claim',section:null},{id:'bc01',type:'Concept',module:'B03',label:'概念A',based_on:[],meta,stance:'author_claim',section:null},{id:'bc02',type:'Concept',module:'B03',label:'概念B',based_on:[],meta,stance:'author_claim',section:null},{id:'ba01',type:'Argument',module:'B02',label:'論拠',based_on:[],meta,stance:'author_claim',section:null}];
  nkg.edges=[{id:'bal01',type:'ArgumentLink',from:'ba01',to:'bt01',relation:'支える',meta},{id:'bcl01',type:'ConceptLink',from:'bc01',to:'bc02',relation:'前提になる',meta}];nkg.gaps=[];
  const validation=validateNkg(nkg);assert.equal(validation.ok,true,validation.errors.join('\n'));
  const {projection:pw}=buildProjection({nkg,validation,cards:[],work:null,tags:[],genreVocab:[]});
  assert.equal(pw.work.kind,'nonfiction');assert.equal(pw.book?.nodes.length,4);assert.equal(pw.book?.edges.length,2);assert.deepEqual(checkPublicWork(pw),[]);
  const body=bookWorkBody(pw).__raw;assert.match(body,/ノンフィクション/);assert.match(body,/要旨/);assert.doesNotMatch(body,/あらすじ|結末のネタバレ|人物関係図|リバースプロット/);
  assert.match(bookPageBody(pw,'arguments').__raw,/book-connection/);assert.equal(hasSubpage(pw,'relations'),false);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfsh-a17-conform-'));fs.mkdirSync(path.join(dir,'nkg'));fs.writeFileSync(path.join(dir,'nkg/nkg.json'),JSON.stringify(nkg));
  const ev=evaluateConformance({workDir:dir,candidate:pw,candidateKind:'public',baseline:null,cfg:parseConformanceConfig({}),rightsFromReport:false});
  assert.equal(ev.items.find(i=>i.item==='synopsis_chars')?.status,'not_measured');assert.equal(ev.items.find(i=>i.item==='figures')?.status,'pass');assert.equal(ev.items.find(i=>i.item==='coverage')?.status,'pass');
  pw.book!.edges=[];const missing=evaluateConformance({workDir:dir,candidate:pw,candidateKind:'public',baseline:null,cfg:parseConformanceConfig({}),rightsFromReport:false});assert.equal(missing.items.find(i=>i.item==='figures')?.shortfalls.length,2);
  pw.work.kind='mixed';assert.equal(hasSubpage(pw,'relations'),false);pw.work.selected_modules!.push('M01');assert.equal(hasSubpage(pw,'relations'),true);
});
test('A17 model schemas remain strict',()=>{
  for(const schema of [PAGE_MENU_SCHEMA,BOOK_WRITE_SCHEMA,...BOOK_GROUPS.map(g=>groupSchema(g.kinds.map(k=>SPECS[k])))])assert.deepEqual(strictSchemaViolations(schema),[]);
});
test('A17: fiction may remove formerly always-on modules and add a traceable new page',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfsh-a17-menu-'));makeFixtureWork(dir);
  const luna=fakePort('luna',cannedS2),haiku=fakePort('haiku',r=>r.task==='s2.modules.review'?{
    additions:[],removals:[{module:'M01',reason:'この観点は不要'}],
    additional_pages:[{slug:'decision-cost',label:'選択の代償',reason:'因果理解に効く',claim_refs:['c0001']}]
  }:cannedS2(r));
  await selectModules(fixtureContext(dir,luna,haiku));
  const sel=JSON.parse(fs.readFileSync(path.join(dir,'nkg/module_selection.json'),'utf8')).module_selection;
  assert.equal(sel.find((m:{module:string})=>m.module==='M01').enabled,false);
  assert.equal(sel.find((m:{module:string})=>m.module==='B11').enabled,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'nkg/page_menu.json'),'utf8')).pages[0].slug,'decision-cost');
});
test('A17: rights recheck scans BKG node text and page prose for A-1 and A-2',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfsh-a17-rights-'));
  fs.mkdirSync(path.join(dir,'gen'));fs.mkdirSync(path.join(dir,'research'));
  const text='これは権利検査のためだけに作成した長い文章でありこの同じ表現が混入していれば確実に検出する必要があります。';
  const {pw}=basePublic();pw.work.kind='nonfiction';pw.book={nodes:[{id:'bk01',module:'B01',type:'Thesis',label:'検査対象',summary:text,stance:'author_claim',section:null,grade:'A',epistemic:'canon',source_refs:['s-check']}],edges:[],pages:[{module:'B00',slug:'summary',label:'要旨',blocks:[{id:'bb01',heading:null,paragraphs:[text,'<img src="https://media.example/test.jpg">'],based_on:['bk01'],stance:'author_claim',spoiler:'none',epistemic:'canon'}]}]};
  fs.writeFileSync(path.join(dir,'gen/public.json'),JSON.stringify(pw));
  fs.writeFileSync(path.join(dir,'research/sources.json'),JSON.stringify([{source_id:'s-check',excerpts:[{text}],raw_text_path:'missing.txt'}]));
  const r=recheckPublic(dir);assert.equal(r.a1_residual,2);assert.ok(r.a2_residual>=1);
});
test('A17: targeted book writing preserves other pages and reviews own summaries as summaries',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfsh-a17-write-'));fs.mkdirSync(path.join(dir,'gen'));
  const {pw}=basePublic();pw.work.kind='nonfiction';
  const keep={module:'B00',slug:'summary',label:'要旨',blocks:[{id:'keep',heading:null,paragraphs:['保持する本文'],based_on:['bc01'],epistemic:'canon' as const,spoiler:'none' as const}]};
  pw.book={nodes:[{id:'bc01',module:'B03',type:'Concept',label:'概念',summary:'著者が提示する概念です。',stance:'author_claim',section:null,grade:'A',epistemic:'canon',source_refs:[]}],edges:[],pages:[keep,{module:'B03',slug:'concepts',label:'概念マップ',blocks:[]}]};
  fs.writeFileSync(path.join(dir,'gen/projection.json'),JSON.stringify(pw));fs.writeFileSync(path.join(dir,'gen/book_pages.json'),JSON.stringify(pw.book.pages));
  const luna=fakePort('luna',r=>{assert.match(r.prompt,/BKGは自作の要約であり原文ではない/);return {findings:[]};});
  const haiku=fakePort('haiku',r=>{assert.match(r.prompt,/ページの作り方について説明しない/);return {blocks:[{id:'draft1',heading:'概念のつながり',paragraphs:['著者は、判断を捉える新しい視点を示しています。'],based_on:['bc01'],stance:'author_claim'}]};});
  await writeBookPages(genContext(dir,luna,haiku),{slugs:['concepts']});
  const pages=JSON.parse(fs.readFileSync(path.join(dir,'gen/book_pages.json'),'utf8'));
  assert.deepEqual(pages[0],keep);assert.equal(pages[1].blocks.length,1);assert.deepEqual(pages[1].blocks[0].based_on,['bc01']);
});
