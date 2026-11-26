/** A17 S3: prose for selected BKG pages. Same author/reviewer split and C-2 gate as narrative pages. */
import type { StageContext, StageResult } from '../job/context.ts';
import type { PublicWork, TextBlock } from '../../../site/src/public-types.ts';
import { readJson, writeJson } from '../nkg/io.ts';
import { pool } from '../util/pool.ts';
import { stageWidth } from '../util/parallel.ts';
import { FINDINGS_SCHEMA, type RawFinding } from '../nkg/review.ts';

const STR={type:'string'}, LIST={type:'array',items:STR};
export const BOOK_WRITE_SCHEMA={type:'object',additionalProperties:false,required:['blocks'],properties:{blocks:{type:'array',items:{type:'object',additionalProperties:false,required:['id','heading','paragraphs','based_on','stance'],properties:{id:STR,heading:STR,paragraphs:LIST,based_on:LIST,stance:{type:'string',enum:['author_claim','fact','harness_interpretation']}}}}}} as const;
interface DraftBlock {id:string;heading:string;paragraphs:string[];based_on:string[];stance:'author_claim'|'fact'|'harness_interpretation'}

export async function writeBookPages(ctx:StageContext,opts:{slugs?:string[]}={}):Promise<StageResult> {
  const pw=readJson<PublicWork>(ctx.workDir,'gen/projection.json',null as never);
  if (!pw.book) return {outputs:[],metrics:{},warnings:[]};
  const menu=readJson<{pages:{module:string;slug:string;label:string}[]}>(ctx.workDir,'nkg/page_menu.json',{pages:pw.book.pages});
  const pages=[{module:'B00',slug:'summary',label:'要旨（全編）'},...menu.pages].filter(p=>!opts.slugs||opts.slugs.includes(p.slug));
  const ids=new Set(pw.book.nodes.map(n=>n.id));
  const reviews:unknown[]=[];
  const written=await pool(pages,stageWidth('write'),async(p)=>{
    const own=p.module==='B00'?pw.book!.nodes:pw.book!.nodes.filter(n=>n.module===p.module);
    const related=new Set(pw.book!.edges.filter(e=>own.some(n=>n.id===e.from||n.id===e.to)).flatMap(e=>[e.from,e.to]));
    const nodes=pw.book!.nodes.filter(n=>own.includes(n)||related.has(n.id));
    const materialIds=new Set(nodes.map(n=>n.id));
    const links=pw.book!.edges.filter(e=>materialIds.has(e.from)&&materialIds.has(e.to));
    if(!nodes.length) return {...p,blocks:[]};
    const mode=pw.work.kind === "fiction" ? "物語を理解するための追加分析ページ。作品の出来事とハーネスの解釈を区別し、人物についての分析は根拠のあるものだけを書く。" : "非物語書籍。あらすじ/結末/登場人物として扱わない。";
    const rules=`${mode}作品「${pw.work.title}」kind=${pw.work.kind}、指定範囲「${pw.work.coverage_label}」。書誌: 著者=${pw.work.creators.map(c=>c.name).join("、")}。ページ「${p.label}」を自分の言葉で書く。対象モジュール${p.module}の議論を中心にする。読者が本の議論を理解するための本文を書く。BKG・ノード・内部ID・素材の処理・ページの作り方について説明しない。方法論や制作説明で節を埋めない。本文引用・会話・場面の再現なし。主張の存在と事実の正しさを混同しない。予測は予測、批判の帰属を明確に。章番号はsectionで確認できたものだけ。章対応未確認は論点順と明記。3〜5節、1200〜2500字を目安、連続した散文、です・ます調。節ごとstanceをauthor_claim/fact/harness_interpretationに分け、異なる区分を同じ節に混ぜない。著者の主張には「著者は〜と論じる」と帰属を書く。based_onは以下の公開ノードID必須。著者の主張を根拠に客観的事実を断定しない。ハーネス解釈は根拠からの独自分析と明記。範囲外/資料のない細部は書かない。\n素材（抜粋ではなくハーネス自身が書いた出典付き要約。原著や出典の原文ではない）:\n${JSON.stringify(nodes)}\n論証・概念のリンク:\n${JSON.stringify(links)}`;
    let blocks=(await ctx.haiku.call({task:`s3.book.${p.slug}`,jobId:ctx.jobId,prompt:rules,schema:BOOK_WRITE_SCHEMA,timeoutMs:240_000})).output as {blocks:DraftBlock[]};
    let unresolved:RawFinding[]=[];
    for(let round=1;round<=2;round++){
      const result=await ctx.luna.call({task:`s3.book.review.${p.slug}`,tools:'none',jobId:ctx.jobId,timeoutMs:180_000,schema:FINDINGS_SCHEMA,prompt:`次の本文をBKG素材に照らして査読。指摘のみ。根拠のない断定/著者の主張と事実の混同/解釈の誤分類/範囲逸脱を指摘。BKGは自作の要約であり原文ではない。同じ用語・命題や自作要約の再利用だけでcopied_phraseにしない。原著や出典の写しだと根拠を示せる場合だけcopied_phrase。原著は渡されていないので未知の原文との一致を推測しない。制作方法・内部IDを読者向け本文に混ぜた節はmisclassifiedとして内容の説明へ直させる。target_idはブロックid。問題なければfindings空配列。\n${rules}\n本文:${JSON.stringify(blocks)}`});
      unresolved=(result.output as {findings:RawFinding[]}).findings??[];
      reviews.push({page:p.slug,round,author:'haiku',reviewer:'luna',findings:unresolved});
      if(!unresolved.length)break;
      blocks=(await ctx.haiku.call({task:`s3.book.revise.${p.slug}`,jobId:ctx.jobId,timeoutMs:240_000,schema:BOOK_WRITE_SCHEMA,prompt:`元の規則に従い査読の指摘を修正。自分の言葉で。指摘箇所以外の内容は保つ。修正後全文を返す。\n${rules}\n本文:${JSON.stringify(blocks)}\n指摘:${JSON.stringify(unresolved)}`})).output as {blocks:DraftBlock[]};
    }
    const copied=new Set(unresolved.filter(f=>f.type==='copied_phrase').map(f=>f.target_id));
    const valid=blocks.blocks.filter(b=>!copied.has(b.id)).flatMap((b,i)=>{
      // Each section cites nodes of its own stance; analysis can reason over any eligible node.
      const basis=b.based_on.filter(id=>ids.has(id)&&materialIds.has(id)&&(b.stance==='harness_interpretation'||pw.book!.nodes.find(n=>n.id===id)?.stance===b.stance));
      if(!basis.length)return [];
      return [{id:`book_${p.slug.replaceAll('-','_')}_${i+1}`,heading:b.heading,paragraphs:b.paragraphs,based_on:basis,spoiler:'none' as const,epistemic:b.stance==='harness_interpretation'?'sfsh_analysis' as const:'canon' as const,stance:b.stance}];
    });
    return {...p,blocks:valid};
  });
  const all=opts.slugs?readJson<NonNullable<PublicWork["book"]>["pages"]>(ctx.workDir,"gen/book_pages.json",[]).map(p=>written.find(n=>n.slug===p.slug)??p):written;
  const prior=opts.slugs?readJson<{rounds:{page:string}[]}>(ctx.workDir,"gen/reviews/book.json",{rounds:[]}).rounds.filter(r=>!opts.slugs!.includes(r.page)):[];
  return {outputs:[writeJson(ctx.workDir,'gen/book_pages.json',all),writeJson(ctx.workDir,'gen/reviews/book.json',{authored_by:'haiku',reviewed_by:'luna',rounds:[...prior,...reviews]}),writeJson(ctx.workDir,'gen/book_write_report.json',{pages:all.map(p=>({slug:p.slug,blocks:p.blocks.length,chars:p.blocks.reduce((n,b)=>n+b.paragraphs.join('').length,0)})),empty_pages:all.filter(p=>!p.blocks.length).map(p=>p.slug)})],metrics:{book_pages:written.length},warnings:written.filter(p=>!p.blocks.length).map(p=>`BKG ${p.label}: 公開根拠不足で本文未掲載`)};
}
