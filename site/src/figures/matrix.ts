/**
 * Figure C — information-asymmetry matrix (REQUIREMENTS §6.4). An HTML table, no SVG.
 *
 * - Rows = secrets, columns = the reader column (placed first, right after the sticky secret column, with
 *   a heavier border and the header "読者") + characters in data order.
 * - Cells: one span per phase (shown by the phase radios + CSS :has(), like figure A). Each state = token
 *   mark + token color; a missing cell = neutral "情報なし" mark (distinct from "unknown").
 * - Scrolls horizontally inside `.fig-c__scroll` only; sticky first column and header row; an edge cue
 *   (hidden by phase.ts when nothing overflows).
 * - Default 8 holder columns (reader always visible); the rest behind "すべての列を表示" (checkbox + :has()).
 * - Alternative: per phase, "秘密 → 誰が・どの状態" lists inside `<details>`.
 */
import type { KnowState, PublicPhase, VizMatrix } from "../public-types.ts";
import type { DesignTokens } from "../design/tokens-types.ts";
import { type Raw, esc, raw } from "../html.ts";
import { type FigureContext, MISSING_LABEL, MISSING_MARK, altFold, cmpStr, phaseAttrs, phaseSwitch, sortedPhases } from "./common.ts";

/**
 * A10 (図のルール): columns per phone-width table (reader included). Each secret gets its own small matrix
 * (rows = phases, columns = reader + people); more people continue in a second table, so at 360/390px the
 * matrix is shown as a matrix without horizontal scrolling or scaling (fixed table layout, text ≥ font.size.small).
 */
export const NARROW_COLUMNS = 4;

/** Default number of visible holder columns (reader included). REQUIREMENTS §6.4: 既定表示の列は8まで. */
export const DEFAULT_COLUMNS = 8;
const STATES: KnowState[] = ["knows", "suspects", "misbelieves", "unknown"];

function mark(t: DesignTokens, s: KnowState | null): string {
  if (!s) return `<span class="fig-ks fig-ks--none" role="img" aria-label="${esc(MISSING_LABEL)}">${esc(MISSING_MARK)}</span>`;
  const k = t.semantic.know_state[s];
  return `<span class="fig-ks fig-ks--${s}" role="img" aria-label="${esc(k.label)}">${esc(k.mark)}</span>`;
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function matrixPhases(ctx: FigureContext, viz: VizMatrix): PublicPhase[] {
  if (ctx.phases.length) return sortedPhases(ctx.phases);
  const ids = [...new Set(viz.cells.map((c) => c.phase))].sort(cmpStr);
  return sortedPhases(ids.map((id, i) => ({ id, label: id, order: i + 1 })));
}

export function renderMatrix(viz: VizMatrix, ctx: FigureContext): Raw | null {
  const t = ctx.tokens;
  const secrets = uniq(viz.secrets);
  const holdersIn = uniq(viz.holders);
  if (!secrets.length || !holdersIn.length) return null;
  const holders = [...holdersIn.filter((h) => h.is_audience), ...holdersIn.filter((h) => !h.is_audience)];
  const phases = matrixPhases(ctx, viz);
  const cell = new Map<string, KnowState>();
  for (const c of viz.cells) cell.set(`${c.secret}\u0000${c.holder}\u0000${c.phase}`, c.state);
  const get = (s: string, h: string, p: string) => cell.get(`${s}\u0000${h}\u0000${p}`) ?? null;

  const extra = (i: number) => i >= DEFAULT_COLUMNS && !holders[i]!.is_audience;
  const colCls = (i: number) => {
    const c: string[] = [];
    if (holders[i]!.is_audience) c.push("fig-c__aud");
    if (extra(i)) c.push("fig-c__col--extra");
    return c.length ? ` class="${c.join(" ")}"` : "";
  };
  const hasExtra = holders.some((_, i) => extra(i));

  const head =
    `<tr><th scope="col" class="fig-c__corner">秘密＼知っている人</th>` +
    holders.map((h, i) => `<th scope="col"${colCls(i)} data-holder="${esc(h.id)}">${esc(h.is_audience ? "読者" : h.label)}</th>`).join("") +
    `</tr>`;
  const body = secrets
    .map((s) => {
      const ep = t.semantic.epistemic[s.epistemic];
      const cells = holders
        .map((h, i) => {
          const spans = phases.map((p, pi) => `<span ${phaseAttrs(phases, pi)}>${mark(t, get(s.id, h.id, p.id))}</span>`).join("");
          const c = colCls(i).replace('class="', 'class="fig-c__cell ');
          return `<td${c || ' class="fig-c__cell"'} data-holder="${esc(h.id)}">${spans}</td>`;
        })
        .join("");
      return `<tr data-secret="${esc(s.id)}"><th scope="row" class="fig-c__secret">${esc(s.label)}<span class="fig-c__ep"><span class="fig-ep fig-ep--${s.epistemic.replace(/_/g, "-")}" role="img" aria-label="${esc(ep.label)}">${esc(ep.mark)}</span></span></th>${cells}</tr>`;
    })
    .join("");

  const legendItems =
    STATES.map((s) => `<li class="fig-legend__item">${mark(t, s)}<span>${esc(t.semantic.know_state[s].label)}</span></li>`).join("") +
    `<li class="fig-legend__item">${mark(t, null)}<span>${esc(MISSING_LABEL)}（資料に記述がない）</span></li>` +
    `<li class="fig-legend__item"><span class="fig-legend__aud">読者</span><span>太い罫で区切った列＝読者（視聴者）がその時点で知っていること</span></li>`;
  const toggle = hasExtra
    ? `<label class="fig-toggle"><input class="fig-c__allcols" type="checkbox"><span>すべての列を表示（全${holders.length}列）</span></label>`
    : "";
  const caption = `情報の非対称性マトリクス。行が秘密、列が人物と読者です。フェーズを切り替えると、その時点で誰が何を知っているかが変わります。${hasExtra ? `既定では${DEFAULT_COLUMNS}列を表示しています。` : ""}`;

  const alt = phases
    .map((p, pi) => {
      const items = secrets
        .map((s) => {
          const known = holders
            .map((h) => ({ h, st: get(s.id, h.id, p.id) }))
            .filter((x): x is { h: (typeof holders)[number]; st: KnowState } => x.st !== null);
          const missing = holders.length - known.length;
          const txt = known.map((x) => `${x.h.is_audience ? "読者" : x.h.label}＝${t.semantic.know_state[x.st].label}`).join("、");
          const rest = !missing ? "" : known.length ? `、ほか${missing}列は${MISSING_LABEL}` : `すべての列で${MISSING_LABEL}`;
          return `<li><span class="fig-alt__secret">${esc(s.label)}</span>：${esc(txt + rest)}</li>`;
        })
        .join("");
      return `<details class="fig-alt__phase"${pi === 0 ? " open" : ""}><summary>${esc(p.label)}</summary><ul class="fig-alt__list">${items}</ul></details>`;
    })
    .join("");

  // Phone width (A10): one small matrix per secret, all phases as rows — readable at 360px without scrolling.
  const chunks: (typeof holders)[] = [];
  for (let i = 0; i < holders.length; i += NARROW_COLUMNS) chunks.push(holders.slice(i, i + NARROW_COLUMNS));
  const mini = secrets
    .map((s) => {
      const ep = t.semantic.epistemic[s.epistemic];
      return chunks
        .map((hs, ci) => {
          const headRow = `<tr><th scope="col" class="fig-c__mini-phase">時期</th>${hs.map((h) => `<th scope="col"${h.is_audience ? ' class="fig-c__aud"' : ""}>${esc(h.is_audience ? "読者" : h.label)}</th>`).join("")}</tr>`;
          const rows = phases
            .map((p) => `<tr><th scope="row" class="fig-c__mini-phase">${esc(p.label)}</th>${hs.map((h) => `<td class="fig-c__cell${h.is_audience ? " fig-c__aud" : ""}">${mark(t, get(s.id, h.id, p.id))}</td>`).join("")}</tr>`)
            .join("");
          const cont = chunks.length > 1 ? `（${ci + 1}/${chunks.length}）` : "";
          return `<table class="fig-c__mini" data-secret="${esc(s.id)}"><caption class="fig-c__mini-cap"><span class="fig-ep fig-ep--${s.epistemic.replace(/_/g, "-")}" role="img" aria-label="${esc(ep.label)}">${esc(ep.mark)}</span>${esc(s.label)}${esc(cont)}</caption><thead>${headRow}</thead><tbody>${rows}</tbody></table>`;
        })
        .join("");
    })
    .join("");
  const narrow =
    `<figure class="fig-figure fig-c__narrow"><figcaption class="fig-caption">情報の非対称性マトリクス。秘密ごとに、行が物語の段階、列が読者と人物です。各段階で誰がその秘密を知っているかを記号で示します。</figcaption>` +
    `<ul class="fig-legend" aria-label="凡例">${legendItems}</ul>${mini}</figure>`;

  const out =
    `<div class="fig-block fig-c fig-phased" data-fig="matrix">` +
    narrow +
    `<div class="fig-controls fig-c__wide">${phaseSwitch(phases, "fig-c-phase", "フェーズ")}${toggle}</div>` +
    `<figure class="fig-figure fig-c__wide"><figcaption class="fig-caption">${esc(caption)}</figcaption>` +
    `<ul class="fig-legend" aria-label="凡例">${legendItems}</ul>` +
    `<p class="fig-c__cue">表は枠の中で横にスクロールできます →</p>` +
    `<div class="fig-c__scroll" tabindex="0" role="region" aria-label="情報の非対称性マトリクス（横にスクロールできます）">` +
    `<table class="fig-c__table"><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
    `</figure>` +
    altFold("matrix", "段階ごとの一覧で見る", `<p class="fig-alt__title">フェーズごとの「秘密 → 誰が・どの状態」（代替表示）</p>${alt}`) +
    `</div>`;
  return raw(out);
}
