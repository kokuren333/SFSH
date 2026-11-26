import { html, type Raw } from './html.ts';
import type { PublicWork, PublicBookNode, TextBlock } from './public-types.ts';

export const kindLabel=(kind?:string|null):string=>({fiction:'フィクション',nonfiction:'ノンフィクション',mixed:'混合（物語と論考）'}[kind??'fiction']??'種別未確認');
export const stanceLabel=(stance:string):string=>({author_claim:'著者の主張',fact:'出典で確認した事実',harness_interpretation:'ハーネスの解釈'}[stance]??'認識区分未確認');
const refs=(w:PublicWork,ids:string[],prefix:string)=>html`<span>出典: ${ids.map(id=>html`<a href="${prefix}sources/#${id}">${w.sources.find(s=>s.source_id===id)?.publisher||id}</a> `)}</span>`;
const node=(w:PublicWork,n:PublicBookNode,prefix:string)=>html`<section class="text-block prose" id="el-${n.id}"><h3>${n.label}</h3><p class="element-meta">${stanceLabel(n.stance)} · 信頼度 ${n.grade}${n.section?` · ${n.section}`:''}</p>${n.summary?html`<p>${n.summary}</p>`:null}<p>${refs(w,n.source_refs,prefix)}</p></section>`;
function prose(w:PublicWork,b:TextBlock,prefix:string):Raw {
  const nodes=w.book!.nodes.filter(n=>b.based_on.includes(n.id));
  const stance=b.stance??(b.epistemic==='sfsh_analysis'?'harness_interpretation':nodes[0]?.stance??'author_claim');
  return html`<section class="text-block prose" id="${b.id}">${b.heading?html`<h2>${b.heading}</h2>`:null}${b.paragraphs.map(p=>html`<p>${p}</p>`)}<p class="element-meta">${stanceLabel(stance)} · 根拠の信頼度 ${nodes.map(n=>n.grade).sort().at(-1)??'未確認'} · ${refs(w,[...new Set(nodes.flatMap(n=>n.source_refs))],prefix)}</p></section>`;
}
export function bookNav(w:PublicWork,prefix='./'):Raw {
  return html`<section class="essence"><h2>${w.work.kind==='mixed'?'論考として読む':w.work.kind==='nonfiction'?'この本の核心':'追加の視点'}</h2><ul class="nav-cards">${(w.book?.pages??[]).filter(p=>p.slug!=='summary').map(p=>html`<li><a class="nav-card" href="${prefix}${p.slug}/"><span class="nav-card__title">${p.label}</span><span class="nav-card__desc">論点と根拠をたどる</span></a></li>`)}</ul></section>`;
}
export function bookSummary(w:PublicWork):Raw {
  const summary=w.book?.pages.find(p=>p.slug==='summary');
  return html`<section><h2>要旨（全編）${w.work.kind==='mixed'?' — 論考の系統':''}</h2>${summary?.blocks.map(b=>prose(w,b,'./'))??html`<p>資料の範囲では要旨を構成できませんでした。</p>`}</section>`;
}
export function bookWorkBody(w:PublicWork):Raw {
  return html`<div class="work-head"><ul class="chips"><li class="chip">書籍</li><li class="chip">${kindLabel(w.work.kind)}</li>${w.work.first_release_year?html`<li class="chip">${w.work.first_release_year}年</li>`:null}</ul><p>著者: ${w.work.creators.map(c=>c.name).join('、')} · 対象範囲: ${w.work.coverage_label}</p></div>${bookNav(w)}${bookSummary(w)}<p><a href="./sources/">出典カードと信頼度</a></p><p>「著者の主張」「出典で確認した事実」「ハーネスの解釈」を各節で区別しています。主張の紹介は、その主張が実証済みであることを意味しません。</p>${w.gaps.length?html`<details><summary>資料上の留保</summary><ul>${w.gaps.map(g=>html`<li>${g.aspect_label}: 資料不足または見解の対立</li>`)}</ul></details>`:null}<p class="disclaimer">非公式・独自分析。原著本文の引用・再現はしていません。</p>`;
}
/** Connected boxes and arrows are a diagram at every width; no scaling or horizontal scroll. */
export function bookPageBody(w:PublicWork,slug:string):Raw {
  const page=w.book!.pages.find(p=>p.slug===slug)!;
  const own=w.book!.nodes.filter(n=>n.module===page.module);
  const edges=w.book!.edges.filter(e=>own.some(n=>n.id===e.from||n.id===e.to));
  const byId=new Map(w.book!.nodes.map(n=>[n.id,n]));
  const diagram=['B02','B03'].includes(page.module);
  return html`<p><a href="../">${w.work.title}</a> · ${kindLabel(w.work.kind)} · 論考として読む</p><p>対象範囲: ${w.work.coverage_label}</p>${diagram?html`<section class="book-diagram" aria-label="${page.label}"><h2>図: ${page.label}</h2><p>矢印は根拠・概念から次の論点への関係を示します。</p>${edges.map(e=>html`<div class="book-connection"><div class="book-box">${byId.get(e.from)?.label}</div><p class="book-arrow">↓ ${e.relation}（信頼度 ${e.grade}）</p><div class="book-box">${byId.get(e.to)?.label}</div></div>`)}${!edges.length?html`<p>関係の根拠が不足しているため、確認済みの論点のみを示します。</p>`:null}<details><summary>関係を一覧で読む</summary><ul>${edges.map(e=>html`<li>${byId.get(e.from)?.label} → ${e.relation} → ${byId.get(e.to)?.label}</li>`)}</ul></details></section>`:null}${page.blocks.map(b=>prose(w,b,'../'))}<section><h2>根拠となる論点</h2>${own.map(n=>node(w,n,'../'))}</section><p><a href="../sources/">出典カード</a> · <a href="../">本の要旨へ</a></p>`;
}
export function bookSources(w:PublicWork):Raw {
  return html`<p><a href="../">${w.work.title}</a> · ${kindLabel(w.work.kind)}</p><p>出典の書誌情報と信頼度を示します。本文の引用・再現は行いません。</p>${w.sources.map(s=>html`<section id="${s.source_id}"><h2><a href="${s.url}">${s.title}</a></h2><p>${s.publisher} · ${s.tier} · 参照日 ${s.accessed}</p>${s.license?html`<p>${s.license}</p>`:null}</section>`)}`;
}
