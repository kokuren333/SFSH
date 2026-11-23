/**
 * Card views of the figures (AMENDMENT 09, BRIEF §14, CP-050). Mobile-first, explanation-style presentation
 * after the ChatGPT / Apps SDK UI guidelines: one card per unit (person, cause, secret), short labels,
 * progressive disclosure (`<details>` for deeper levels and "さらに表示"), no horizontal scrolling and no
 * scaled-down drawing at any width. These are the primary presentation on every width; the SVG / table
 * figures come first on every width since A10 (図のルール); these cards follow them as the supplement (figure-adapter.ts).
 *
 * Pure build-time renderers like the rest of the module: public viz data → escaped markup (html``), no fs,
 * no network, deterministic (stable sort by data fields and ids).
 * CSS: site/src/styles/cards.css (`fc-` prefix).
 */
import type { KnowState, PlotNode, PublicPhase, VizMatrix, VizRelations, VizReversePlot, VizTimeline } from "../public-types.ts";
import { type Raw, html } from "../html.ts";
import { type FigureContext, FACTOR_LABEL, LEVEL_LABEL, MISSING_LABEL, cmpStr, intervalLabel, sortedPhases } from "./common.ts";

/** Characters shown before "さらに表示" (relations). */
export const CARDS_DEFAULT_PEOPLE = 6;
/** Causes shown before "さらに表示" (reverse plot, per level). */
export const CARDS_DEFAULT_STEPS = 5;

const KS_ORDER: KnowState[] = ["knows", "suspects", "misbelieves", "unknown"];

function ep(ctx: FigureContext, e: keyof FigureContext["tokens"]["semantic"]["epistemic"], grade?: string): Raw {
  const x = ctx.tokens.semantic.epistemic[e];
  return html`<span class="fc-ep fc-ep--${e.replace(/_/g, "-")}"><span class="fc-ep__mark" aria-hidden="true">${x.mark}</span>${x.label}${grade ? html` · 信頼度 ${grade}` : null}</span>`;
}

function more(items: Raw[], limit: number, label: (n: number) => string): Raw {
  if (items.length <= limit) return html`${items}`;
  return html`${items.slice(0, limit)}<li class="fc-more-item"><details class="fc-more"><summary>${label(items.length - limit)}</summary><ul class="fc-list">${items.slice(limit)}</ul></details></li>`;
}

// ------------------------------------------------------------------ A: relations
export function renderRelationsCards(viz: VizRelations, ctx: FigureContext): Raw | null {
  const chars = [...viz.characters].sort((a, b) => a.prominence - b.prominence || cmpStr(a.id, b.id));
  if (!chars.length) return null;
  const rank = new Map(chars.map((c, i) => [c.id, i]));
  const name = new Map(chars.map((c) => [c.id, c.label]));
  const factions = new Map(viz.factions.map((f) => [f.id, f.label]));
  const phases = sortedPhases(ctx.phases);
  // Each relation is listed once, under the more central of its two characters.
  const owner = (r: VizRelations["relations"][number]) => ((rank.get(r.from) ?? 1e9) <= (rank.get(r.to) ?? 1e9) ? r.from : r.to);
  const rels = viz.relations.filter((r) => name.has(r.from) && name.has(r.to));
  const order = (a: (typeof rels)[number], b: (typeof rels)[number]) => {
    const pa = a.phase_from ? phases.findIndex((p) => p.id === a.phase_from) : -1;
    const pb = b.phase_from ? phases.findIndex((p) => p.id === b.phase_from) : -1;
    return pa - pb || cmpStr(a.id, b.id);
  };
  const card = (c: (typeof chars)[number]): Raw => {
    const mine = rels.filter((r) => owner(r) === c.id).sort(order);
    const rows = mine.map((r) => {
      const other = r.from === c.id ? r.to : r.from;
      const v = ctx.tokens.semantic.valence[r.valence];
      return html`<li class="fc-rel" data-rel="${r.id}"><span class="fc-rel__who">${name.get(other)}</span><span class="fc-rel__kind">${r.kind}</span><span class="fc-val fc-val--${r.valence}">${v.label}</span><span class="fc-rel__when">${intervalLabel(phases, r.phase_from, r.phase_to)}${r.changed_by_label ? html` · きっかけ: ${r.changed_by_label}` : null}</span></li>`;
    });
    const faction = c.faction ? factions.get(c.faction) || "所属あり（名称未掲載）" : null;
    return html`<li class="fc-card fc-person" id="fc-${c.id}"><h3 class="fc-title">${c.label}</h3>${faction ? html`<div class="fc-sub">${faction}</div>` : null}${c.summary ? html`<p class="fc-text">${c.summary}</p>` : null}${rows.length ? html`<ul class="fc-rels" aria-label="${c.label}の関係">${rows}</ul>` : null}<div class="fc-meta">${ep(ctx, c.epistemic, c.grade)}</div></li>`;
  };
  const items = chars.map(card);
  return html`<section class="fc fc-relations" aria-labelledby="fc-rel-h"><h2 id="fc-rel-h">人物ごとの関係</h2><p class="fc-lead">物語の中心にいる人物から順に、関係・その性質・続いた時期を並べます。関係は二人のうち中心に近い人物の欄に一度だけ載せています。</p><ul class="fc-list">${more(items, CARDS_DEFAULT_PEOPLE, (n) => `ほかの人物を表示（${n}人）`)}</ul></section>`;
}

// ------------------------------------------------------------------ B: reverse plot
function count(n: PlotNode): number {
  return n.children.reduce((s, c) => s + 1 + count(c), 0);
}

function step(n: PlotNode, ctx: FigureContext): Raw {
  const kids = n.children;
  const tag = [LEVEL_LABEL[n.level], n.factor_kind ? FACTOR_LABEL[n.factor_kind] : null].filter(Boolean).join(" · ");
  const deeper = kids.length
    ? html`<details class="fc-deeper"><summary>さらにさかのぼる（${count(n)}件）</summary><ol class="fc-steps">${kids.map((k) => step(k, ctx))}</ol></details>`
    : null;
  return html`<li class="fc-step fc-step--${n.level}" data-id="${n.id}"><div class="fc-eyebrow">${tag}</div><h4 class="fc-title">${n.label}</h4>${n.summary ? html`<p class="fc-text">${n.summary}</p>` : null}${n.analysis ? html`<div class="fc-analysis"><div class="fc-analysis__label">${ep(ctx, "sfsh_analysis")}</div><p class="fc-text">${n.analysis}</p></div>` : null}<div class="fc-meta">${ep(ctx, n.epistemic, n.grade)}</div>${deeper}</li>`;
}

export function renderReversePlotCards(viz: VizReversePlot, ctx: FigureContext): Raw | null {
  if (!viz.trees.length) return null;
  const tree = (root: PlotNode, i: number): Raw => {
    const steps = root.children.map((c) => step(c, ctx));
    const shown = steps.slice(0, CARDS_DEFAULT_STEPS), rest = steps.slice(CARDS_DEFAULT_STEPS);
    return html`<section class="fc-tree" aria-labelledby="fc-tree-${i}"><div class="fc-card fc-outcome"><div class="fc-eyebrow">${viz.trees.length > 1 ? `結末 ${i + 1}` : "結末"}</div><h2 class="fc-title" id="fc-tree-${i}">${root.label}</h2>${root.summary ? html`<p class="fc-text">${root.summary}</p>` : null}${root.analysis ? html`<div class="fc-analysis"><div class="fc-analysis__label">${ep(ctx, "sfsh_analysis")}</div><p class="fc-text">${root.analysis}</p></div>` : null}<div class="fc-meta">${ep(ctx, root.epistemic, root.grade)}</div></div>${steps.length ? html`<p class="fc-flow">この結末の直接の原因（${root.children.length}件）</p><ol class="fc-steps">${shown}</ol>${rest.length ? html`<details class="fc-more"><summary>ほかの原因を表示（${rest.length}件）</summary><ol class="fc-steps">${rest}</ol></details>` : null}` : null}</section>`;
  };
  return html`<div class="fc fc-plot"><p class="fc-lead">結末から順に、直接の原因、その要因、根本の原因へとさかのぼります。「さらにさかのぼる」で一段ずつ開けます。</p>${viz.trees.map(tree)}</div>`;
}

// ------------------------------------------------------------------ C: matrix
export function renderMatrixCards(viz: VizMatrix, ctx: FigureContext): Raw | null {
  const seen = new Set<string>();
  const secrets = viz.secrets.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  const hs = new Set<string>();
  const holdersIn = viz.holders.filter((h) => (hs.has(h.id) ? false : (hs.add(h.id), true)));
  if (!secrets.length || !holdersIn.length) return null;
  const holders = [...holdersIn.filter((h) => h.is_audience), ...holdersIn.filter((h) => !h.is_audience)];
  const phases: PublicPhase[] = ctx.phases.length
    ? sortedPhases(ctx.phases)
    : sortedPhases([...new Set(viz.cells.map((c) => c.phase))].sort(cmpStr).map((id, i) => ({ id, label: id, order: i + 1 })));
  const cell = new Map<string, KnowState>();
  for (const c of viz.cells) cell.set(`${c.secret}\u0000${c.holder}\u0000${c.phase}`, c.state);
  const ks = ctx.tokens.semantic.know_state;
  const who = (h: (typeof holders)[number]) => (h.is_audience ? html`<strong class="fc-reader">読者</strong>` : html`${h.label}`);

  const secretCard = (s: (typeof secrets)[number]): Raw => {
    // One row per run of phases with the same states (consecutive identical phases are merged).
    const sig = (p: PublicPhase) => holders.map((h) => cell.get(`${s.id}\u0000${h.id}\u0000${p.id}`) ?? "").join("|");
    const runs: { from: PublicPhase; to: PublicPhase; p: PublicPhase }[] = [];
    for (const p of phases) {
      const last = runs.at(-1);
      if (last && sig(last.p) === sig(p)) last.to = p;
      else runs.push({ from: p, to: p, p });
    }
    const rows = runs
      .map((r) => {
        const groups = KS_ORDER.map((st) => ({ st, hs: holders.filter((h) => cell.get(`${s.id}\u0000${h.id}\u0000${r.p.id}`) === st) })).filter((g) => g.hs.length);
        if (!groups.length) return null;
        const when = r.from.id === r.to.id ? r.from.label : `${r.from.label}〜${r.to.label}`;
        return html`<li class="fc-phase"><div class="fc-phase__label">${phases.length > 1 ? when : "全体"}</div><ul class="fc-states">${groups.map((g) => html`<li class="fc-state fc-state--${g.st}"><span class="fc-state__label"><span class="fc-ks fc-ks--${g.st}" aria-hidden="true">${ks[g.st].mark}</span>${ks[g.st].label}</span><span class="fc-state__who">${g.hs.map((h, i) => html`${i ? "、" : ""}${who(h)}`)}</span></li>`)}</ul></li>`;
      })
      .filter((x): x is Raw => !!x);
    return html`<li class="fc-card fc-secret" data-secret="${s.id}"><h3 class="fc-title">${s.label}</h3>${rows.length ? html`<ol class="fc-phases">${rows}</ol>` : html`<p class="fc-text">${MISSING_LABEL}（資料に記述がない）</p>`}<div class="fc-meta">${ep(ctx, s.epistemic, s.grade)}</div></li>`;
  };
  return html`<section class="fc fc-matrix" aria-labelledby="fc-mx-h"><h2 id="fc-mx-h">秘密ごとに、誰がいつ知るか</h2><p class="fc-lead">秘密ごとに、物語の段階ごとの「知っている・疑っている・誤解している・知らない」を並べます。読者（視聴者）がその時点で知っていることも同じ欄に入れています。資料に記述がない人物は載せていません。</p><ul class="fc-list">${secrets.map(secretCard)}</ul></section>`;
}

// ------------------------------------------------------------------ timeline
export function renderTimelineCards(viz: VizTimeline, ctx: FigureContext): Raw | null {
  if (!viz.events.length) return null;
  const phases = sortedPhases(ctx.phases);
  const evs = [...viz.events].sort((a, b) => a.story_order - b.story_order || cmpStr(a.id, b.id));
  const label = (id: string | null) => (id && phases.find((p) => p.id === id)?.label) || "時期の記述なし";
  return html`<section class="fc fc-timeline" aria-labelledby="fc-tl-h"><h2 id="fc-tl-h">起きた順と、明かされる時期</h2><p class="fc-lead">物語の中で起きた順に並べ、それぞれが作中のどの時期に明かされるかを添えます。</p><ol class="fc-card fc-tl">${evs.map((e, i) => html`<li class="fc-tl__item"><span class="fc-tl__num" aria-hidden="true">${i + 1}</span><span class="fc-tl__body"><span class="fc-tl__label">${e.label}</span><span class="fc-tl__when">明かされる時期: ${label(e.disclosure_phase)}</span></span></li>`)}</ol></section>`;
}
