/**
 * Optional timeline (M04 double axis, REQUIREMENTS §6.2): two parallel vertical axes — story order (left)
 * and disclosure phase (right) — with a connecting line per main event. Crossing lines show events told
 * out of order. One static SVG per width class (CSS media queries), alternative table right after.
 */
import type { PublicPhase, VizTimeline } from "../public-types.ts";
import type { DesignTokens } from "../design/tokens-types.ts";
import { type Raw, esc, raw } from "../html.ts";
import { type FigureContext, type WidthClass, altFold, cmpStr, fmt, sortedPhases, stackTables, widthClasses, wrap } from "./common.ts";

type Ev = VizTimeline["events"][number];
const UNKNOWN = "時期の記述なし";

function svgFor(t: DesignTokens, cls: WidthClass, evs: Ev[], groups: { label: string; evs: Ev[] }[]): string {
  const f = t.font.size.small;
  const lineH = Math.ceil(f * 1.3);
  const m = t.space.s;
  const W = cls.frame;
  const mid = cls.key === "narrow" ? t.space.xl + t.space.m : cls.key === "medium" ? t.space.section * 2 : t.space.section * 3;
  const colW = (W - 2 * m - mid) / 2;
  const leftX = m + colW;
  const rightX = m + colW + mid;
  const dot = t.space.xs;
  const rowGap = t.space.s;
  let y = m + lineH + rowGap;
  const out: string[] = [];
  out.push(`<text class="fig-t__axis" x="${fmt(leftX)}" y="${fmt(m + f)}" text-anchor="end">物語内の順番</text>`);
  out.push(`<text class="fig-t__axis" x="${fmt(rightX)}" y="${fmt(m + f)}">明かされる時期</text>`);
  const left = new Map<string, number>();
  for (const e of evs) {
    const lines = wrap(`${e.story_order}. ${e.label}`, colW - dot * 3, f, 3);
    const h = lines.length * lineH;
    left.set(e.id, y + h / 2);
    lines.forEach((l, k) => out.push(`<text class="fig-t__label" x="${fmt(leftX - dot * 3)}" y="${fmt(y + k * lineH + f * 0.95)}" text-anchor="end">${esc(l)}</text>`));
    y += h + rowGap;
  }
  const leftEnd = y;
  y = m + lineH + rowGap;
  const right = new Map<string, number>();
  for (const g of groups) {
    out.push(`<text class="fig-t__phase" x="${fmt(rightX + dot * 3)}" y="${fmt(y + f * 0.95)}">${esc(g.label)}</text>`);
    y += lineH + t.space.xs;
    for (const e of g.evs) {
      const lines = wrap(e.label, colW - dot * 3, f, 3);
      const h = lines.length * lineH;
      right.set(e.id, y + h / 2);
      lines.forEach((l, k) => out.push(`<text class="fig-t__label" x="${fmt(rightX + dot * 3)}" y="${fmt(y + k * lineH + f * 0.95)}">${esc(l)}</text>`));
      y += h + rowGap;
    }
  }
  const H = Math.max(leftEnd, y) + m;
  const links = evs
    .map((e) => {
      const y1 = left.get(e.id)!;
      const y2 = right.get(e.id)!;
      return `<g class="fig-t__ev" data-id="${esc(e.id)}"><path class="fig-t__link" d="M${fmt(leftX)} ${fmt(y1)} L${fmt(rightX)} ${fmt(y2)}"/><circle class="fig-t__dot" cx="${fmt(leftX)}" cy="${fmt(y1)}" r="${fmt(dot)}"/><circle class="fig-t__dot" cx="${fmt(rightX)}" cy="${fmt(y2)}" r="${fmt(dot)}"/></g>`;
    })
    .join("");
  const axes = `<path class="fig-t__axisline" d="M${fmt(leftX)} ${fmt(m + lineH)} V${fmt(H - m)}"/><path class="fig-t__axisline" d="M${fmt(rightX)} ${fmt(m + lineH)} V${fmt(H - m)}"/>`;
  return `<svg class="fig-svg fig-t__svg fig-w--${cls.key}" viewBox="0 0 ${fmt(W)} ${fmt(H)}" data-wclass="${cls.key}" data-min-frame="${fmt(cls.frame)}" role="img" aria-label="${esc(`時系列の二重軸（${cls.name}向け）`)}">${axes}${links}${out.join("")}</svg>`;
}

export function renderTimeline(viz: VizTimeline, ctx: FigureContext): Raw | null {
  const t = ctx.tokens;
  const seen = new Set<string>();
  const evs = [...viz.events]
    .sort((a, b) => a.story_order - b.story_order || cmpStr(a.id, b.id))
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  if (!evs.length) return null;
  const phases: PublicPhase[] = sortedPhases(ctx.phases);
  const known = new Set(phases.map((p) => p.id));
  const groups = phases.map((p) => ({ label: p.label, evs: evs.filter((e) => e.disclosure_phase === p.id) })).filter((g) => g.evs.length);
  const unknown = evs.filter((e) => e.disclosure_phase === null || !known.has(e.disclosure_phase));
  if (unknown.length) groups.push({ label: UNKNOWN, evs: unknown });
  const svgs = widthClasses(t)
    .map((c) => svgFor(t, c, evs, groups))
    .join("");
  const label = new Map(phases.map((p) => [p.id, p.label]));
  const rows = evs
    .map((e) => `<tr><td>${e.story_order}</td><th scope="row">${esc(e.label)}</th><td>${esc((e.disclosure_phase && label.get(e.disclosure_phase)) || UNKNOWN)}</td></tr>`)
    .join("");
  const caption = "時系列の二重軸。左は物語の中で起きた順番、右は作品の中で明かされる時期です。線が交差するところは、起きた順と明かされる順が入れ替わっています。";
  return raw(stackTables(
    `<div class="fig-block fig-t" data-fig="timeline"><figure class="fig-figure"><figcaption class="fig-caption">${esc(caption)}</figcaption>${svgs}</figure>` +
      altFold("timeline", "出来事の一覧表で見る", `<div class="fig-table-wrap"><table class="fig-table"><caption>主要な出来事（代替表示・全${evs.length}件）</caption><thead><tr><th scope="col">物語内の順番</th><th scope="col">出来事</th><th scope="col">明かされる時期</th></tr></thead><tbody>${rows}</tbody></table></div>`) + `</div>`,
  ));
}
