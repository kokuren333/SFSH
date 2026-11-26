import { BOOK_MENU } from './bookMenu.ts';
import type { StageContext, StageResult } from '../job/context.ts';
import { readActiveClaims, readSourceCards, writeJson } from './io.ts';
import { readWork } from '../works/store.ts';

export const PAGE_MENU_SCHEMA = {
  type:'object', additionalProperties:false, required:['choices','additional_pages'], properties:{
    choices:{type:'array',items:{type:'object',additionalProperties:false,required:['module','enabled','reason','claim_refs'],properties:{
      module:{type:'string',enum:BOOK_MENU.map(m=>m.module)},enabled:{type:'boolean'},reason:{type:'string'},claim_refs:{type:'array',items:{type:'string'}}
    }}},
    additional_pages:{type:'array',items:{type:'object',additionalProperties:false,required:['slug','label','reason','claim_refs'],properties:{
      slug:{type:'string'},label:{type:'string'},reason:{type:'string'},claim_refs:{type:'array',items:{type:'string'}}
    }}}
  }
} as const;
export interface PageChoice { module:string; enabled:boolean; reason:string; claim_refs:string[] }
export interface AdditionalPage { slug:string; label:string; reason:string; claim_refs:string[] }
export interface BookSelection { choices:PageChoice[]; additional_pages:AdditionalPage[] }

/** The model chooses what helps understanding; code only requires traceable basis and safe routes. */
export async function selectBookModules(ctx:StageContext):Promise<StageResult> {
  const w=readWork(ctx.workDir), claims=readActiveClaims(ctx.workDir), cards=readSourceCards(ctx.workDir);
  const usable=claims.filter(c=>c.source_ids.some(id=>cards.some(s=>s.source_id===id)));
  const result=await ctx.luna.call({task:'s2.book.modules',tools:'none',jobId:ctx.jobId,schema:PAGE_MENU_SCHEMA,
    prompt:`作品「${w.title}」kind=${w.kind}。BKGのモジュールを選ぶ。全項目は必須ではない。理解に効かない項目は省略、根拠がないものは不足として記録。章番号が未確認でも論点ごとの論理構成は選べる。人物関係や結末へ変換しない。必要な独自ページもadditional_pagesで追加できる（slugは英小文字とハイフン）。選択/不選択/追加の理由は自分の言葉で、根拠claim_refs必須。\n${BOOK_MENU.map(m=>`${m.module} ${m.label}: ${m.guide}`).join('\n')}\n調査済みクレーム:\n${JSON.stringify(usable.map(c=>({id:c.claim_id,text:c.text,aspects:c.aspects})))}`});
  const out=result.output as BookSelection;
  writeJson(ctx.workDir,"nkg/book_selection_proposed.json",out);
  const ids=new Set(usable.map(c=>c.claim_id));
  const choices=BOOK_MENU.map(m=>{
    const c=out.choices?.find(c=>c.module.trim()===m.module), refs=(c?.claim_refs??[]).filter(id=>ids.has(id));
    return {module:m.module,weight:c?.enabled&&refs.length?1:0,enabled:!!c?.enabled&&refs.length>0,reason:c?.reason||'対象に不要または根拠不足',claim_refs:refs};
  });
  const reserved=new Set(['sources','overview','relations','reverse-plot','matrix','people','events','themes','context','interpretations','quiz','summary',...BOOK_MENU.map(m=>m.slug)]);
  const additions=(out.additional_pages??[]).filter(p=>/^[a-z][a-z-]{1,40}$/.test(p.slug)&&!reserved.has(p.slug)&&p.label.trim()&&p.claim_refs.some(id=>ids.has(id)));
  const unique=additions.filter((p,i)=>additions.findIndex(q=>q.slug===p.slug)===i);
  const selection=[...choices.map(({claim_refs,...c})=>c),{module:'B11',weight:unique.length?1:0,enabled:!!unique.length,reason:unique.map(p=>p.reason).join('; ')||'追加ページ不要'}];
  const file={generated_at:ctx.now().toISOString(),genres:{proposed:[],accepted:w.genres.map(slug=>({slug,label:slug,reason:'既存分類を再利用',claim_refs:[]})),dropped:[]},expansion:{enabled:selection.filter(c=>c.enabled).map(c=>c.module),weights:{},hints:{},origin:{}},haiku:{proposed:{additions:[],removals:[]},applied:[],rejected:[]},claim_counts:{},sufficiency_min_claims:1,insufficient:[],module_selection:selection,gaps:[]};
  const menu=[...BOOK_MENU.filter(m=>choices.find(c=>c.module===m.module)?.enabled).map(m=>({module:m.module,slug:m.slug,label:m.label})),...unique.map(p=>({module:'B11',slug:p.slug,label:p.label}))];
  ctx.log(`A17 BKG selection: ${JSON.stringify(choices)}; additional=${JSON.stringify(unique)}`);
  return {outputs:[writeJson(ctx.workDir,'nkg/module_selection.json',file),writeJson(ctx.workDir,'nkg/page_menu.json',{pages:menu,decisions:choices,additional_pages:unique})],metrics:{modules_enabled:selection.filter(c=>c.enabled).length},warnings:[]};
}
