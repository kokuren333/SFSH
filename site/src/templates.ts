import { createHash } from 'node:crypto';
import { html } from './html.ts';
import type { Raw } from './html.ts';
import type { CatalogItem, Epistemic, Grade, PlotNode, PublicArc, PublicCharacter, PublicMotive, PublicWork, SiteInputIndex, Spoiler, TextBlock } from './public-types.ts';
import type { DesignTokens } from './design/tokens-types.ts';
import { compareReading, readingGroup } from './search-core.ts';
import { axes, facets } from './filter-core.ts';
import type { Axis } from './filter-core.ts';
import { figure } from './figure-adapter.ts';
import type { FigureModule } from './figure-adapter.ts';
import { displayName } from './site-settings.ts';
import type { SiteSettings } from './site-settings.ts';

export const creatorId = (name: string): string => 'c' + createHash('sha256').update(name).digest('hex').slice(0, 8);
export const prefixFor = (path: string): string => '../'.repeat(path.split('/').length - 1) || './';
export const spoilerLabel = (s: Spoiler): string => ({ none: 'ネタバレなし', mid: '中盤のネタバレ', ending: '結末のネタバレ' })[s];
export function spoiler(s: Spoiler, body: Raw): Raw {
  return s === 'ending' ? html`<details class="spoiler"><summary>結末に触れる内容（クリックで表示）</summary>${body}</details>` : html`${s === 'mid' ? html`<p class="spoiler-label">中盤のネタバレ</p>` : null}${body}`;
}
export function badge(ep: Epistemic, tokens: DesignTokens, grade?: string): Raw {
  const e = tokens.semantic.epistemic[ep];
  return html`<span class="epistemic ep-${ep}">${e.mark} ${e.label}${grade ? html` · 信頼度 ${grade}` : null}</span>`;
}
interface Evidence { id: string; epistemic: Epistemic; grade: Grade }
function evidence(work: PublicWork, ids: string[]): Evidence[] {
  const nodes: Evidence[] = [];
  const visit = (node: PlotNode) => { nodes.push(node); node.children.forEach(visit); };
  work.viz.reverse_plot.trees.forEach(visit);
  const el = work.elements;
  nodes.push(...work.viz.relations.characters, ...work.viz.relations.relations, ...(work.viz.matrix?.secrets || []), ...work.pages.themes.items, ...work.pages.context.items, ...work.pages.context.iconic, ...el.events, ...el.motives, ...el.arcs, ...el.world_rules, ...el.setups, ...el.emotion_beats);
  return nodes.filter(n => ids.includes(n.id));
}
function evidenceGrade(work: PublicWork, ids: string[]): Grade | undefined {
  // TextBlock/QuizItem have no grade field. Only derive from explicitly cited public elements.
  return evidence(work, ids).map(e => e.grade).sort().at(-1);
}
function block(b: TextBlock, tokens: DesignTokens, work: PublicWork): Raw {
  const grade = evidenceGrade(work, b.based_on);
  // AMENDMENT 09: a card — title, lede (first paragraph), body, then a quiet meta line (mark + label + grade).
  return spoiler(b.spoiler, html`<section class="text-block" id="${b.id}">${b.heading ? html`<h2>${b.heading}</h2>` : null}${b.paragraphs.map((p, i) => html`<p${i === 0 && b.paragraphs.length > 1 ? html` class="lede"` : null}>${p}</p>`)}<div class="evidence-grade">${badge(b.epistemic, tokens)}<span class="evidence-grade__text">${grade ? html`根拠要素の信頼度: ${grade}` : html`信頼度: 未付与`}</span></div></section>`);
}
/** S2 analysis prose (CP-026): always labelled 「独自分析」 with the sfsh_analysis mark, never by color alone. */
function analysisBlock(text: string | null, tokens: DesignTokens): Raw | null {
  return text ? html`<div class="analysis"><p class="analysis-label">${badge('sfsh_analysis', tokens)}</p><p>${text}</p></div>` : null;
}
function legend(tokens: DesignTokens): Raw {
  return html`<details class="legend help"><summary>表示の見方（認識区分の凡例）</summary><ul class="legend__list">${(Object.keys(tokens.semantic.epistemic) as Epistemic[]).map(ep => html`<li>${badge(ep, tokens)}</li>`)}</ul><p>信頼度（A〜D）は、参照した出典の種類と数から計算した値です。A がもっとも根拠が強いことを表します。</p></details>`;
}
export function searchForm(prefix: string, id: string): Raw {
  return html`<form class="search-form" action="${prefix}search/" method="get"><label for="${id}">作品を検索</label><div class="search-controls"><input id="${id}" name="q" type="search" autocomplete="off" aria-label="作品を検索"><button type="submit">検索</button></div></form>`;
}
/** Common pages (WP-5.4), linked from every footer. */
export const commonPages = [
  { dir: 'about', title: 'このサイトについて' },
  { dir: 'policy', title: '方針' },
  { dir: 'takedown', title: '取り下げ依頼の窓口' },
  { dir: 'spoilers', title: 'ネタバレについて' },
] as const;
/** rootOverride: link prefix used instead of the relative one (404.html is served by Pages at any depth, M5). */
export function layout(site: SiteSettings, path: string, title: string, body: Raw, script?: string, phase = false, rootOverride?: string): string {
  const p = rootOverride ?? prefixFor(path), name = displayName(site);
  const nav = html`<nav aria-label="グローバル"><a href="${p}">トップ</a><a href="${p}works/">作品索引</a><a href="${p}genres/">ジャンル</a><a href="${p}about/">このサイトについて</a></nav>`;
  return html`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="sfsh-root" content="${p}"><title>${title} | ${name}</title><link rel="stylesheet" href="${p}assets/site.css">${script ? html`<script type="module" src="${p}assets/client/${script}.js"></script>` : null}${phase ? html`<script type="module" src="${p}assets/client/phase.js"></script>` : null}</head><body><header class="site-header"><a class="site-name" href="${p}">${name}</a>${searchForm(p, 'header-q')}<details class="mobile-menu"><summary>メニュー</summary>${nav}</details><div class="wide-nav">${nav}</div></header><main class="text-column"><h1>${title}</h1>${body}</main><footer class="site-footer"><p>非公式・独自分析サイト</p><nav aria-label="サイト情報">${commonPages.map(c => html`<a href="${p}${c.dir}/">${c.title}</a>`)}<a href="${p}sitemap/">サイトマップ</a></nav></footer></body></html>`.__raw + '\n';
}
function label(index: SiteInputIndex, axis: 'genres' | 'tags' | 'media', slug: string): string {
  return index.vocab[axis].find(v => v.slug === slug)?.label || slug;
}
export function rows(items: CatalogItem[], p: string, index: SiteInputIndex): Raw {
  return html`<ol class="work-list">${items.map(w => html`<li class="work-row" data-work-id="${w.work_id}" data-title="${w.title}" data-reading="${w.title_reading || w.title}" data-added="${w.first_published_at || ''}" data-updated="${w.updated_at || ''}"><a href="${p}${w.url}">${w.title}</a><p>${label(index, 'media', w.medium)} · ${w.creators.join('、')} · ${w.genres.map(g => label(index, 'genres', g)).join('、')}</p><p>対象範囲: ${w.coverage_label} · ${spoilerLabel(w.spoiler_max)}</p></li>`)}</ol>`;
}
export function indexBody(index: SiteInputIndex): Raw {
  const ordered = [...index.works].sort(compareReading);
  const groups = [...new Set(ordered.map(readingGroup))];
  return html`<label class="sort-control">並び替え<select id="sort"><option value="title">タイトル順</option><option value="added">追加順</option><option value="updated">更新順</option></select></label><nav class="index-jumps" aria-label="行見出し">${groups.map((g, n) => html`<a href="#row-${n}">${g}</a>`)}</nav><div id="work-index">${groups.map((g, n) => html`<section class="index-group" id="row-${n}"><h2>${g}</h2>${rows(ordered.filter(w => readingGroup(w) === g), '../', index)}</section>`)}</div>`;
}
export function topBody(index: SiteInputIndex): Raw {
  const recent = [...index.works].sort((a, b) => (b.first_published_at || '').localeCompare(a.first_published_at || '') || compareReading(a, b)).slice(0, 12);
  return html`${searchForm('./', 'top-q')}<section><h2>新着</h2>${rows(recent, './', index)}</section><section><h2>ジャンルから探す</h2>${entrances(index, 'genres', './')}</section><section><h2>媒体から探す</h2>${entrances(index, 'media', './')}</section><a href="./works/">すべての作品を見る</a>`;
}
export function entrances(index: SiteInputIndex, axis: 'genres' | 'media', p: string): Raw {
  return html`<ul class="entrances">${index.vocab[axis].map(v => {
    const count = index.works.filter(w => axis === 'media' ? w.medium === v.slug : w.genres.includes(v.slug)).length;
    return count ? html`<li><a href="${p}${axis}/${v.slug}/">${v.label} (${count})</a></li>` : null;
  })}</ul>`;
}
export function searchBody(index: SiteInputIndex): Raw {
  const names: Record<Axis, string> = { medium: '媒体', genre: 'ジャンル', tag: 'タグ', status: '完結状況', decade: '初出年代', matrix: 'C マトリクスあり' };
  const counts = facets(index.works, {});
  return html`<form id="search-filters" class="filter-form" action="../search/" method="get"><label for="query">検索語</label><input id="query" name="q" type="search">${axes.map(axis => html`<fieldset><legend>${names[axis]}</legend>${counts[axis].map(o => html`<label class="filter-option"><input type="checkbox" name="${axis}" value="${o.value}"><span>${facetLabel(index, axis, o.value)}</span> (<span data-count="${axis}:${o.value}">${o.count}</span>)</label>`)}</fieldset>`)}<button type="submit">検索</button><button id="clear-filters" type="button">絞り込みを解除</button></form><noscript><p>検索には JavaScript が必要です。作品索引から探せます <a href="../works/">作品索引</a></p></noscript><div id="search-results" aria-live="polite"></div>`;
}
function facetLabel(index: SiteInputIndex, axis: Axis, value: string): string {
  if (axis === 'medium' || axis === 'genre' || axis === 'tag') return label(index, axis === 'medium' ? 'media' : axis === 'genre' ? 'genres' : 'tags', value);
  if (axis === 'status') return ({ completed: '完結', ongoing: '連載中', unknown: '不明' } as Record<string, string>)[value] || value;
  if (axis === 'matrix') return value === 'true' ? 'あり' : 'なし';
  return value === 'unknown' ? '不明' : value + '年代';
}
export const subpages = { 'reverse-plot': 'リバースプロット', relations: '人物関係図', matrix: '情報の非対称性マトリクス', people: '人物と動機・変容', events: '出来事と因果・世界のルール・伏線', themes: 'テーマ・批評', context: '文化的文脈', interpretations: '解釈の分岐', quiz: '理解度テスト', sources: '出典' } as const;
export type Subpage = keyof typeof subpages;
/** Pages without content are not emitted (matrix: has_matrix; people/events: CP-026 element lists). */
export function hasSubpage(work: PublicWork, page: Subpage): boolean {
  const e = work.elements;
  if (page === 'matrix') return work.work.has_matrix;
  if (page === 'people') return e.motives.length + e.arcs.length > 0;
  if (page === 'events') return e.events.length + e.world_rules.length + e.setups.length + e.emotion_beats.length > 0;
  return true;
}
type Elements = PublicWork['elements'];
const SPOILER_RANK: Record<Spoiler, number> = { none: 0, mid: 1, ending: 2 };
const MOTIVE_KIND: Record<PublicMotive['kind'], string> = { goal: '目標', fear: '恐れ', belief: '信念', conflict: '葛藤' };
const CAUSE_KIND: Record<Elements['events'][number]['caused_by'][number]['kind'], string> = { causes: '引き起こす', enables: '可能にする', motivates: '動機づける', prevents: '妨げる' };
const RULE_KIND: Record<Elements['world_rules'][number]['kind'], string> = { constraint: '制約', ability: '能力', institution: '制度' };
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedPhases = (work: PublicWork) => [...work.phases].sort((a, b) => a.order - b.order || byId(a, b));
const maxSpoiler = (a: Spoiler, b: Spoiler): Spoiler => (SPOILER_RANK[a] >= SPOILER_RANK[b] ? a : b);
function phaseLabel(work: PublicWork, id: string | null): string {
  return (id && work.phases.find(p => p.id === id)?.label) || 'フェーズ不明';
}
function phaseSpan(work: PublicWork, from: string | null, to: string | null): string {
  if (!from && !to) return '全期間';
  const ps = sortedPhases(work);
  const a = from ? phaseLabel(work, from) : ps[0]?.label || '最初';
  const b = to ? phaseLabel(work, to) : ps.at(-1)?.label || '最後';
  return a === b ? a : `${a}〜${b}`;
}
interface Ref { label: string; spoiler: Spoiler; href: string | null; note?: string }
/** Labels of related elements. A reference that spoils more than its container never leaks: ending ones are folded, mid ones labelled. */
function refList(title: string, items: (Ref | null)[], container: Spoiler): Raw | null {
  const all = items.filter((r): r is Ref => !!r);
  if (!all.length) return null;
  const li = (r: Ref) => html`<li>${r.href ? html`<a href="${r.href}">${r.label}</a>` : r.label}${r.note ? html`（${r.note}）` : null}${r.spoiler === 'mid' && container === 'none' ? html` <span class="spoiler-label">中盤のネタバレ</span>` : null}</li>`;
  const folded = (r: Ref) => r.spoiler === 'ending' && container !== 'ending';
  const shown = all.filter(r => !folded(r)), hidden = all.filter(folded);
  return html`<div class="ref-group"><p class="ref-title">${title}</p>${shown.length ? html`<ul class="ref-list">${shown.map(li)}</ul>` : null}${hidden.length ? spoiler('ending', html`<ul class="ref-list">${hidden.map(li)}</ul>`) : null}</div>`;
}
function element(s: Spoiler, id: string, body: Raw): Raw {
  return spoiler(s, html`<section class="element" id="el-${id}">${body}</section>`);
}
const para = (s: string | null): Raw | null => (s ? html`<p>${s}</p>` : null);
function resolver(work: PublicWork, page: 'people' | 'events') {
  const events = new Map(work.elements.events.map(e => [e.id, e]));
  const chars = new Map(work.viz.relations.characters.map(c => [c.id, c]));
  const motives = new Map(work.elements.motives.map(m => [m.id, m]));
  return {
    event: (id: string, note?: string): Ref | null => {
      const e = events.get(id);
      return e ? { label: e.label, spoiler: e.spoiler, href: page === 'events' ? `#el-${e.id}` : `../events/#el-${e.id}`, note } : null;
    },
    character: (id: string): Ref | null => {
      const c = chars.get(id);
      return c ? { label: c.label, spoiler: c.spoiler, href: null } : null;
    },
    motive: (id: string): Ref | null => {
      const m = motives.get(id);
      return m ? { label: m.label, spoiler: m.spoiler, href: `#el-${m.id}`, note: chars.get(m.owner)?.label } : null;
    },
  };
}
/** /works/<id>/people/: per character (prominence order) its motives and arcs. Lists only, abstract (C-3). */
function peopleBody(work: PublicWork, tokens: DesignTokens): Raw {
  const r = resolver(work, 'people');
  const order = new Map(sortedPhases(work).map((p, i) => [p.id, i]));
  const start = (m: PublicMotive) => (m.phase_from ? order.get(m.phase_from) ?? 1e9 : -1);
  const motives = [...work.elements.motives].sort((a, b) => start(a) - start(b) || byId(a, b));
  const arcs = [...work.elements.arcs].sort(byId);
  const factions = new Map(work.viz.relations.factions.map(f => [f.id, f.label]));
  const motive = (m: PublicMotive, parent: Spoiler) => {
    const s = maxSpoiler(parent, m.spoiler);
    return element(m.spoiler, m.id, html`<h3>${MOTIVE_KIND[m.kind]}: ${m.label}</h3>${badge(m.epistemic, tokens, m.grade)}<p class="element-meta">種類: ${MOTIVE_KIND[m.kind]} · 期間: ${phaseSpan(work, m.phase_from, m.phase_to)}</p>${para(m.summary)}${analysisBlock(m.analysis, tokens)}${refList('動かした出来事', m.drives.map(id => r.event(id)), s)}${refList('対立する動機', m.conflicts_with.map(r.motive), s)}`);
  };
  const arc = (a: PublicArc, parent: Spoiler) => element(a.spoiler, a.id, html`<h3>変容: ${a.label}</h3>${badge(a.epistemic, tokens, a.grade)}<p class="element-meta">変容の型: ${a.arc_type}</p><p class="arc-change">${a.initial_state} → ${a.final_state}</p>${para(a.summary)}${analysisBlock(a.analysis, tokens)}${refList('転機となった出来事', a.turns_at.map(id => r.event(id)), maxSpoiler(parent, a.spoiler))}`);
  const items = (owns: (id: string) => boolean, parent: Spoiler) => html`${motives.filter(m => owns(m.owner)).map(m => motive(m, parent))}${arcs.filter(a => owns(a.character)).map(a => arc(a, parent))}`;
  const chars = [...work.viz.relations.characters].sort((a, b) => a.prominence - b.prominence || byId(a, b));
  const has = (c: PublicCharacter) => motives.some(m => m.owner === c.id) || arcs.some(a => a.character === c.id);
  const known = new Set(chars.map(c => c.id));
  const orphan = motives.some(m => !known.has(m.owner)) || arcs.some(a => !known.has(a.character));
  const person = (c: PublicCharacter) => spoiler(c.spoiler, html`<section class="person" id="el-${c.id}"><h2>${c.label}</h2>${badge(c.epistemic, tokens, c.grade)}${c.faction ? html`<p class="element-meta">所属: ${factions.get(c.faction) || '所属あり（名称未掲載）'}</p>` : null}${para(c.summary)}${items(id => id === c.id, c.spoiler)}</section>`);
  return html`<p class="page-lead">人物ごとに、何を望み・恐れ・信じていたか（動機）と、物語を通じてどう変わったか（変容）を要約します。場面の再現ではありません。</p>${chars.filter(has).map(person)}${orphan ? html`<section class="person"><h2>その他の人物</h2>${items(id => !known.has(id), 'none')}</section>` : null}`;
}
/** /works/<id>/events/: main events in story order with causes/effects, then world rules, setups, emotion beats by phase. */
function eventsBody(work: PublicWork, tokens: DesignTokens): Raw {
  const r = resolver(work, 'events');
  const el = work.elements;
  const events = [...el.events].sort((a, b) => (a.story_order ?? Infinity) - (b.story_order ?? Infinity) || byId(a, b));
  const intensity = (n: number) => (Number.isFinite(n) ? `強さ ${Math.min(5, Math.max(1, Math.round(n)))}/5` : '強さ 不明');
  const phases = sortedPhases(work);
  const groups = [...phases.map(p => ({ label: p.label, beats: el.emotion_beats.filter(b => b.phase === p.id) })), { label: 'フェーズ不明', beats: el.emotion_beats.filter(b => !phases.some(p => p.id === b.phase)) }].filter(g => g.beats.length);
  const eventSection = events.length ? html`<section><h2>主な出来事</h2><p>物語の順に並べています。</p>${events.map(e => element(e.spoiler, e.id, html`<h3>${e.label}</h3>${badge(e.epistemic, tokens, e.grade)}<p class="element-meta">${e.phase_ref ? `フェーズ: ${phaseLabel(work, e.phase_ref)}` : 'フェーズ不明'}</p>${para(e.summary)}${refList('原因', e.caused_by.map(c => r.event(c.event, CAUSE_KIND[c.kind])), e.spoiler)}${refList('結果', e.leads_to.map(c => r.event(c.event, CAUSE_KIND[c.kind])), e.spoiler)}`))}</section>` : null;
  const ruleSection = el.world_rules.length ? html`<section><h2>世界のルール</h2>${el.world_rules.map(w => element(w.spoiler, w.id, html`<h3>${RULE_KIND[w.kind]}: ${w.label}</h3>${badge(w.epistemic, tokens, w.grade)}<p class="element-meta">種類: ${RULE_KIND[w.kind]}</p>${para(w.summary)}<p>帰結: ${w.consequence}</p>${refList('影響を受ける出来事・人物', w.constrains.map(id => r.event(id) || r.character(id)), w.spoiler)}`))}</section>` : null;
  const setupSection = el.setups.length ? html`<section><h2>伏線と回収</h2>${el.setups.map(s => element(s.spoiler, s.id, html`<h3>${s.label}</h3>${badge(s.epistemic, tokens, s.grade)}<p>意味: ${s.meaning}</p>${refList('回収される出来事', s.pays_off.map(id => r.event(id)), s.spoiler)}`))}</section>` : null;
  const beatSection = groups.length ? html`<section><h2>感情の起伏</h2>${groups.map(g => html`<h3>${g.label}</h3>${g.beats.map(b => element(b.spoiler, b.id, html`<h4>${b.label}</h4>${badge(b.epistemic, tokens, b.grade)}<p class="element-meta">感情: ${b.emotion} · ${intensity(b.intensity)}</p>${para(b.summary)}${refList('きっかけ', b.evoked_by.map(id => r.event(id)), b.spoiler)}`))}`)}</section>` : null;
  return html`<p class="page-lead">主な出来事のつながり（原因と結果）、物語世界のルール、伏線と回収、感情の起伏を一覧にします。場面の再現ではなく要約です。</p>${eventSection}${ruleSection}${setupSection}${beatSection}`;
}
/** AMENDMENT 09: the essence pages (story structure) lead the work page as cards; the rest follow as a compact list. */
export const ESSENCE: Subpage[] = ['reverse-plot', 'relations', 'matrix', 'people', 'events', 'themes'];
const SUBPAGE_DESC: Record<Subpage, string> = {
  'reverse-plot': '結末から原因へさかのぼる',
  relations: '誰と誰が、どう結びつき変わるか',
  matrix: '誰が何を、いつ知っていたか',
  people: '何を望み、どう変わったか',
  events: '何が何を引き起こしたか',
  themes: '作品の問いと評価',
  context: 'なぜ有名なのか・受け止められ方',
  interpretations: '読みが分かれる点',
  quiz: '要点を確かめる問題',
  sources: '参照した資料の一覧',
};
function subpageCount(work: PublicWork, k: Subpage): string | null {
  const e = work.elements, v = work.viz;
  const n = (xs: number[], labels: string[]) => xs.map((x, i) => (x ? `${labels[i]} ${x}` : null)).filter(Boolean).join(' · ') || null;
  const nodes = (ns: PlotNode[]): number => ns.reduce((s, x) => s + 1 + nodes(x.children), 0);
  switch (k) {
    case 'reverse-plot': return n([v.reverse_plot.trees.length, nodes(v.reverse_plot.trees.flatMap(t => t.children))], ['結末', '原因']);
    case 'relations': return n([v.relations.characters.length, v.relations.relations.length], ['人物', '関係']);
    case 'matrix': return v.matrix ? n([v.matrix.secrets.length], ['秘密']) : null;
    case 'people': return n([e.motives.length, e.arcs.length], ['動機', '変容']);
    case 'events': return n([e.events.length, e.world_rules.length, e.setups.length], ['出来事', 'ルール', '伏線']);
    case 'themes': return n([work.pages.themes.items.length], ['テーマ']);
    case 'quiz': return n([work.pages.quiz.length], ['問']);
    case 'sources': return n([work.sources.length], ['件']);
    default: return null;
  }
}
function navCard(work: PublicWork, k: Subpage, p: string): Raw {
  const count = subpageCount(work, k);
  return html`<li><a class="nav-card" href="${p}${k}/"><span class="nav-card__title">${subpages[k]}</span><span class="nav-card__desc">${SUBPAGE_DESC[k]}</span>${count ? html`<span class="nav-card__meta">${count}</span>` : null}</a></li>`;
}
function navRow(work: PublicWork, k: Subpage, p: string): Raw {
  return html`<li><a class="nav-row" href="${p}${k}/"><span class="nav-row__title">${subpages[k]}</span><span class="nav-row__desc">${SUBPAGE_DESC[k]}</span></a></li>`;
}
const chip = (text: string, href?: string, sub?: string | null): Raw =>
  href ? html`<li><a class="chip" href="${href}">${text}${sub ? html`<span class="chip__sub">${sub}</span>` : null}</a></li>` : html`<li><span class="chip chip--plain">${text}${sub ? html`<span class="chip__sub">${sub}</span>` : null}</span></li>`;
export function workBody(work: PublicWork, index: SiteInputIndex, tokens: DesignTokens): Raw {
  const w = work.work;
  const essence = ESSENCE.filter(k => hasSubpage(work, k));
  const others = (Object.keys(subpages) as Subpage[]).filter(k => !ESSENCE.includes(k) && hasSubpage(work, k));
  const head = html`<div class="work-head"><ul class="chips" aria-label="分類">${chip(label(index, 'media', w.medium), `../../media/${w.medium}/`)}${w.first_release_year ? chip(`${w.first_release_year}年`) : null}${w.genres.map(g => chip(label(index, 'genres', g), `../../genres/${g}/`))}</ul><p class="coverage">対象範囲: ${w.coverage_label} · ${spoilerLabel(w.spoiler_max)}</p></div>`;
  const nav = html`<section class="essence" aria-labelledby="essence-h"><h2 id="essence-h">この作品の核心</h2><nav aria-label="作品の分析"><ul class="nav-cards">${essence.map(k => navCard(work, k, ''))}</ul></nav></section>`;
  const facts: Raw[] = [];
  if (w.title_original) facts.push(html`<div class="fact"><dt>原題</dt><dd>${w.title_original}</dd></div>`);
  if (w.creators.length) facts.push(html`<div class="fact"><dt>スタッフ</dt><dd><ul class="chips">${w.creators.map(c => chip(c.name, `../../creators/${creatorId(c.name)}/`, c.role))}</ul></dd></div>`);
  if (w.aliases_display.length) facts.push(html`<div class="fact"><dt>別名</dt><dd><ul class="chips">${w.aliases_display.map(a => chip(a))}</ul></dd></div>`);
  if (w.tags.length) facts.push(html`<div class="fact"><dt>タグ</dt><dd><ul class="chips">${w.tags.map(t => chip(label(index, 'tags', t)))}</ul></dd></div>`);
  if (w.publisher) facts.push(html`<div class="fact"><dt>発行・制作</dt><dd>${w.publisher}</dd></div>`);
  const info = html`<section class="card work-info"><h2>作品情報</h2><dl class="facts">${facts}</dl></section>`;
  const more = others.length ? html`<section class="more-pages" aria-labelledby="more-h"><h2 id="more-h">さらに読む</h2><ul class="nav-list" aria-label="そのほかのページ">${others.map(k => navRow(work, k, ''))}</ul></section>` : null;
  const gaps = work.gaps.length ? html`<details class="help"><summary>情報不足で載せていない観点（${work.gaps.length}件）</summary><ul>${work.gaps.map(g => html`<li>この観点は情報不足のため未掲載: ${g.aspect_label}</li>`)}</ul></details>` : null;
  return html`${head}${nav}<div class="overview">${work.pages.overview.map(b => block(b, tokens, work))}</div>${info}${more}${legend(tokens)}${gaps}<p class="disclaimer">非公式・独自分析サイト</p>`;
}
export function subpageBody(work: PublicWork, page: Subpage, tokens: DesignTokens, module: FigureModule | null): Raw {
  const crumbs = html`<nav class="breadcrumbs" aria-label="パンくず"><a href="../../../">トップ</a> › <a href="../../../works/">作品索引</a> › <a href="../">${work.work.title}</a> › ${subpages[page]}</nav>`;
  let body: Raw;
  if (page === 'relations' || page === 'reverse-plot' || page === 'matrix') {
    const name = page === 'reverse-plot' ? 'reverse_plot' : page;
    const note = work.pages.figure_notes[name];
    body = html`${note ? block(note, tokens, work) : null}<div class="figure-column">${figure(work, name, tokens, module)}${page === 'reverse-plot' && work.viz.timeline ? figure(work, 'timeline', tokens, module) : null}</div>`;
  } else if (page === 'people') {
    body = peopleBody(work, tokens);
  } else if (page === 'events') {
    body = eventsBody(work, tokens);
  } else if (page === 'sources') {
    body = html`<ol class="sources">${work.sources.map(s => {
      const valid = /^https?:\/\/[^\s]+$/i.test(s.url);
      return html`<li><h2>${s.title}</h2><p>発行者: ${s.publisher || '不明'}</p><p>${valid ? html`<a href="${s.url}" rel="nofollow noopener">${s.url}</a>` : html`${s.url}`}</p><p>参照日: ${s.accessed} · ${s.tier}</p>${s.license ? html`<p>${s.license}</p>` : null}</li>`;
    })}</ol>`;
  } else if (page === 'quiz') {
    body = html`${work.pages.quiz.map(q => html`<section>${q.spoiler === 'mid' ? html`<p class="spoiler-label">中盤のネタバレ</p>` : null}<h2>${q.question}</h2><p class="evidence-grade">${evidence(work, q.based_on).length ? evidence(work, q.based_on).map(e => badge(e.epistemic, tokens, e.grade)) : html`認識区分・信頼度: 未付与`}</p><details class="spoiler"><summary>${q.spoiler === 'ending' ? '結末に触れる内容（クリックで表示）' : '答えと解説'}</summary><p>${q.answer}</p><p>${q.explanation}</p></details></section>`)}`;
  } else if (page === 'interpretations') {
    body = html`${work.pages.interpretations.intro.map(b => block(b, tokens, work))}${work.pages.interpretations.items.map(i => spoiler(i.spoiler, html`<section><h2>${i.topic}</h2>${i.positions.map(p => html`<p>${badge(p.epistemic, tokens)} · 信頼度: 未付与 · ${p.claim}</p>`)}</section>`))}`;
  } else {
    const data = work.pages[page];
    body = html`${data.intro.map(b => block(b, tokens, work))}${data.items.map(i => spoiler(i.spoiler, html`<section><h2>${i.label}</h2>${badge(i.epistemic, tokens, i.grade)}${'question' in i ? html`<p>${i.question}</p><p>${i.tension}</p><p>${i.values.join('、')}</p>` : null}${i.summary ? html`<p>${i.summary}</p>` : null}${analysisBlock(i.analysis, tokens)}</section>`))}${page === 'context' ? work.pages.context.iconic.map(i => spoiler(i.spoiler, html`<section><h2>${i.label}</h2>${badge(i.epistemic, tokens, i.grade)}<p>${i.why_famous}</p>${analysisBlock(i.analysis, tokens)}</section>`)) : null}`;
  }
  const siblings = (Object.keys(subpages) as Subpage[]).filter(k => k !== page && hasSubpage(work, k));
  const sib = html`<section class="sibling-pages" aria-labelledby="sib-h"><h2 id="sib-h">この作品のほかのページ</h2><nav aria-label="この作品のほかのページ"><ul class="chips">${chip('作品ページに戻る', '../')}${siblings.map(k => chip(subpages[k], `../${k}/`))}</ul></nav></section>`;
  return html`${crumbs}<p class="coverage">対象範囲: ${work.work.coverage_label} · ${spoilerLabel(work.work.spoiler_max)}</p>${body}${sib}${legend(tokens)}`;
}
