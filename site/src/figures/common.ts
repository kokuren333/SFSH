/**
 * Shared helpers for the figure renderers (WP-2.3). Pure functions only: no fs, no network, no clock, no
 * Math.random. Every number written to markup goes through `fmt()` (rounded to 0.1px) so output is
 * byte-identical for identical input.
 */
import type { DesignTokens } from "../design/tokens-types.ts";
import type { Epistemic, PublicPhase } from "../public-types.ts";
import { esc } from "../html.ts";

export interface FigureContext {
  tokens: DesignTokens;
  phases: PublicPhase[];
  workId: string;
}

/** Round to 0.1 and normalise -0. */
export function r1(n: number): number {
  const v = Math.round(n * 10) / 10;
  return v === 0 ? 0 : v;
}

/** Number → attribute text (0.1px precision, no trailing zeros). */
export function fmt(n: number): string {
  return String(r1(n));
}

/** Seeded LCG (same constants as d3-force's internal one). Deterministic in [0, 1). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296;
}

/** Code-unit string compare (locale independent, deterministic). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byId<T extends { id: string }>(a: T, b: T): number {
  return cmpStr(a.id, b.id);
}

/**
 * Conservative glyph width in em: half-width (ASCII, Latin, halfwidth katakana) 0.6em, everything else
 * (kana, kanji, full-width forms, symbols ≥ U+2000) 1em. Browsers cannot be measured at build time
 * (wp03 §5), so the estimate errs on the wide side.
 */
export function charEm(cp: number): number {
  if (cp < 0x2000) return 0.6;
  if (cp >= 0xff61 && cp <= 0xff9f) return 0.6;
  return 1;
}

export function textWidth(s: string, fontSize: number): number {
  let em = 0;
  for (const ch of s) em += charEm(ch.codePointAt(0)!);
  return em * fontSize;
}

/** Visual truncation to at most `max` characters (code points), the last one being "…". Data is never cut. */
export function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/** Truncate so the estimated width stays ≤ maxWidth. */
export function truncateToWidth(s: string, maxWidth: number, fontSize: number): string {
  if (textWidth(s, fontSize) <= maxWidth) return s;
  const cps = Array.from(s);
  let out = "";
  for (const ch of cps) {
    if (textWidth(out + ch + "…", fontSize) > maxWidth) break;
    out += ch;
  }
  return (out || cps[0]!) + "…";
}

/** Greedy wrap by estimated width (character level: Japanese has no spaces). Last line truncated with "…". */
export function wrap(s: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  const cps = Array.from(s);
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    if (cur && textWidth(cur + ch, fontSize) > maxWidth) {
      if (lines.length === maxLines - 1) {
        lines.push(truncateToWidth(cur + cps.slice(i).join(""), maxWidth, fontSize));
        return lines;
      }
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

/** Phases sorted by order, then id. Empty input → a single pseudo phase so figures still render. */
export function sortedPhases(phases: PublicPhase[]): PublicPhase[] {
  const p = [...phases].sort((a, b) => a.order - b.order || cmpStr(a.id, b.id));
  return p.length ? p : [{ id: "all", label: "全体", order: 1 }];
}

/** Axis-aligned box. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

export function inside(b: Box, w: number, h: number): boolean {
  return b.x0 >= 0 && b.y0 >= 0 && b.x1 <= w && b.y1 <= h;
}

// ---------------------------------------------------------------- width classes (REQUIREMENTS §6.4 A07)

export type WidthKey = "narrow" | "medium" | "wide";

export interface WidthClass {
  key: WidthKey;
  /** Japanese name used in aria labels. */
  name: string;
  /** Minimum viewport width of the class (CSS px). */
  minViewport: number;
  /**
   * Minimum CSS width of the figure frame at that viewport: viewport − 2 × gutter (capped at figureMax).
   * The SVG viewBox width is set to exactly this, so the rendered scale is ≥ 1 everywhere in the class and
   * figure text (font.size.small) never renders below its token size (≥ 13px).
   */
  frame: number;
  /** Preferred height/width ratio for the force layout frame (narrow = portrait). */
  aspect: number;
  /** Default number of characters shown in figure A. */
  defaultNodes: number;
}

/** Smallest supported viewport (REQUIREMENTS §6.4: 対応幅は 360〜1920px). */
export const MIN_VIEWPORT = 360;

export function widthClasses(t: DesignTokens): WidthClass[] {
  const g = t.layout.gutter;
  const frame = (v: number) => Math.min(v - 2 * g, t.layout.figureMax);
  return [
    { key: "narrow", name: "スマートフォン", minViewport: MIN_VIEWPORT, frame: frame(MIN_VIEWPORT), aspect: 1.45, defaultNodes: 8 },
    { key: "medium", name: "タブレット", minViewport: t.breakpoint.tablet, frame: frame(t.breakpoint.tablet), aspect: 0.8, defaultNodes: 12 },
    { key: "wide", name: "PC", minViewport: t.breakpoint.pc, frame: frame(t.breakpoint.pc), aspect: 0.56, defaultNodes: 12 },
  ];
}

// ---------------------------------------------------------------- labels

export const LEVEL_LABEL: Record<"outcome" | "direct" | "factor" | "root", string> = {
  outcome: "結末",
  direct: "直接原因",
  factor: "要因",
  root: "根本原因",
};

export const FACTOR_LABEL: Record<"political" | "psychological" | "social" | "chance" | "rule", string> = {
  political: "政治的",
  psychological: "心理的",
  social: "社会的",
  chance: "偶然",
  rule: "ルール",
};

export const MISSING_MARK = "・";
export const MISSING_LABEL = "情報なし";

/** Epistemic mark + label as escaped HTML (mark carries a class for optional coloring; never color alone). */
export function epHtml(t: DesignTokens, ep: Epistemic): string {
  const e = t.semantic.epistemic[ep];
  return `<span class="fig-ep fig-ep--${ep.replace(/_/g, "-")}" aria-hidden="true">${esc(e.mark)}</span>${esc(e.label)}`;
}

/** Interval label for a relation: "序盤〜中盤", "全期間", or a single phase. */
export function intervalLabel(phases: PublicPhase[], from: string | null, to: string | null): string {
  const f = from ? phases.find((p) => p.id === from) : undefined;
  const tt = to ? phases.find((p) => p.id === to) : undefined;
  if (!f && !tt) return "全期間";
  if (f && tt && f.id === tt.id) return f.label;
  return `${f ? f.label : "最初"}〜${tt ? tt.label : "最後"}`;
}

/** Phase radio group (no JS: radios + CSS :has(); phase.ts reflects ?phase=). */
export function phaseSwitch(phases: PublicPhase[], name: string, title: string): string {
  if (phases.length <= 1) return "";
  const opts = phases
    .map(
      (p, i) =>
        `<label class="fig-switch__opt"><input class="fig-phase-radio" type="radio" name="${esc(name)}" value="${esc(p.id)}" data-pi="${i + 1}"${i === 0 ? " checked" : ""}><span>${esc(p.label)}</span></label>`,
    )
    .join("");
  return `<fieldset class="fig-switch"><legend class="fig-switch__title">${esc(title)}</legend>${opts}</fieldset>`;
}

/** Attributes of an element that belongs to one phase (shown by CSS when that phase's radio is checked). */
export function phaseAttrs(phases: PublicPhase[], idx: number, extraClass = ""): string {
  const always = phases.length <= 1 ? " fig-ph--always" : "";
  const extra = extraClass ? " " + extraClass : "";
  return `class="fig-ph${always}${extra}" data-phase="${esc(phases[idx]!.id)}" data-pi="${idx + 1}"`;
}

// ---------------------------------------------------------------- A10 (図のルール): tables and folds at phone width

/**
 * Data tables stack into labelled rows below the tablet width (BRIEF §14 図のルール, REQUIREMENTS §6.4): each
 * body cell gets `data-label` = its column header, and the CSS (`.fig-table--stack`) shows one row per block
 * with the header above each value at 360/390px, so no table needs horizontal scrolling on a phone. From the
 * tablet width up the table is an ordinary table again. Input is code-generated markup only (headers are
 * fixed strings already escaped by `esc`), so the string transform cannot see model text as markup.
 */
export function stackTables(s: string): string {
  return s.replace(/<table class="fig-table">([\s\S]*?)<\/table>/g, (_m, inner: string) => {
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(inner);
    const labels = head ? [...head[1]!.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "")) : [];
    const body = inner.replace(/<tbody>([\s\S]*?)<\/tbody>/, (_b, rows: string) => {
      const out = rows.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/g, (tr) => {
        let i = 0;
        return tr.replace(/<(td|th)\b/g, (cell) => `${cell} data-label="${labels[i++] ?? ""}"`);
      });
      return `<tbody>${out}</tbody>`;
    });
    return `<table class="fig-table fig-table--stack">${body}</table>`;
  });
}

/** The alternative tables/lists of a figure, folded behind one visible entry (shown at every width). */
export function altFold(altFor: string, summary: string, inner: string): string {
  return `<details class="fig-alt" data-alt-for="${esc(altFor)}"><summary class="fig-alt__summary">${esc(summary)}</summary>${inner}</details>`;
}
