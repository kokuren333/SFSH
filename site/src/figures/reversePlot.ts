/**
 * Figure B — reverse plot (REQUIREMENTS §6.4): Outcome-rooted cause tree, one per `trees[]`.
 *
 * Decision (documented in logs/m2/worker_f_report.md):
 * - The SVG tree (tablet and PC) draws depth ≤ 2 (結末 → 直接原因 → 要因); nodes with deeper causes show
 *   "▼続きn件（一覧）". A tree is ALWAYS drawn at tablet and PC widths (§6.4 「タブレット以上は木」):
 *   top→down (d3-hierarchy `tree()`) when it fits the class' minimum frame width at scale ≥ 1, otherwise a
 *   left→right tree (root at the left, one column per depth, labels wrapped to the column width, breadth
 *   grows downward — height is free), so text never renders below the token size.
 * - The nested `<details>` list is the expansion mechanism at every width (smartphone: it IS the figure;
 *   tablet/PC: it follows the tree and holds the summaries and deeper levels). `open` for depth < 2, i.e.
 *   depth ≤ 2 visible by default. Same DOM at every width → expansion state survives rotation/resize.
 * - The alternative table (all nodes, all levels, with summaries) follows each tree's figure.
 */
import { hierarchy, tree } from "d3-hierarchy";
import type { PlotNode, VizReversePlot } from "../public-types.ts";
import type { DesignTokens } from "../design/tokens-types.ts";
import { type Raw, esc, raw } from "../html.ts";
import { type FigureContext, FACTOR_LABEL, LEVEL_LABEL, epHtml, fmt, truncateToWidth, widthClasses, wrap } from "./common.ts";

/** Depth drawn in the SVG tree and expanded by default in the list (0 = outcome). */
export const DEFAULT_DEPTH = 2;

function metaText(t: DesignTokens, n: PlotNode): string {
  const fk = n.factor_kind ? `・${FACTOR_LABEL[n.factor_kind]}` : "";
  return `${t.semantic.epistemic[n.epistemic].mark}${LEVEL_LABEL[n.level]}${fk}`;
}

function countDesc(n: PlotNode): number {
  return n.children.reduce((s, c) => s + 1 + countDesc(c), 0);
}

interface Cut {
  node: PlotNode;
  kids: Cut[];
  hidden: number;
}

function cut(n: PlotNode, depth: number): Cut {
  if (depth >= DEFAULT_DEPTH) return { node: n, kids: [], hidden: countDesc(n) };
  return { node: n, kids: n.children.map((c) => cut(c, depth + 1)), hidden: 0 };
}

interface BoxSpec {
  lines: string[];
  meta: string;
  more: string | null;
  h: number;
}

export interface TreeGeom {
  f: number;
  lineH: number;
  pad: number;
  boxW: number;
  gapX: number;
  gapY: number;
  margin: number;
}

export function treeGeom(t: DesignTokens): TreeGeom {
  const f = t.font.size.small;
  return { f, lineH: Math.ceil(f * 1.3), pad: t.space.xs, boxW: 10 * f, gapX: t.space.m, gapY: t.space.l, margin: t.space.s };
}

function spec(t: DesignTokens, g: TreeGeom, c: Cut, boxW = g.boxW, maxLines = 3): BoxSpec {
  const inner = boxW - 2 * g.pad;
  const lines = wrap(c.node.label, inner, g.f, maxLines);
  const meta = truncateToWidth(metaText(t, c.node), inner, g.f);
  const more = c.hidden > 0 ? `▼続き${c.hidden}件（一覧）` : null;
  const n = lines.length + 1 + (more ? 1 : 0);
  return { lines, meta, more, h: n * g.lineH + 2 * g.pad };
}

function boxSvg(t: DesignTokens, g: TreeGeom, c: Cut, s: BoxSpec, depth: number, x0: number, y0: number, w: number): string {
  const tx = x0 + g.pad;
  const base = (k: number) => y0 + g.pad + k * g.lineH + g.f * 0.95;
  const label = s.lines.map((l, k) => `<text class="fig-b__label" x="${fmt(tx)}" y="${fmt(base(k))}">${esc(l)}</text>`).join("");
  const meta = `<text class="fig-b__meta fig-b__meta--${c.node.epistemic.replace(/_/g, "-")}" x="${fmt(tx)}" y="${fmt(base(s.lines.length))}">${esc(s.meta)}</text>`;
  const more = s.more ? `<text class="fig-b__more" x="${fmt(tx)}" y="${fmt(base(s.lines.length + 1))}">${esc(s.more)}</text>` : "";
  const title = s.lines.join("") !== c.node.label ? `<title>${esc(c.node.label)}</title>` : "";
  return `<g class="fig-b__node fig-b__node--${c.node.level}" data-id="${esc(c.node.id)}" data-depth="${depth}">${title}<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(s.h)}" rx="${fmt(Math.min(t.radius.control, s.h / 2))}"/>${label}${meta}${more}</g>`;
}

function svgOpen(wkey: string, wname: string, frame: number, W: number, H: number, orient: "tb" | "lr"): string {
  const dir = orient === "tb" ? "上から下" : "左から右";
  const aria = `リバースプロットの木（${wname}向け、${dir}、深さ${DEFAULT_DEPTH}まで）`;
  return `<svg class="fig-svg fig-b__svg fig-w--${wkey}" viewBox="0 0 ${fmt(W)} ${fmt(H)}" data-wclass="${wkey}" data-min-frame="${fmt(frame)}" data-orient="${orient}" role="img" aria-label="${esc(aria)}">`;
}

/** Top→down tree (d3-hierarchy `tree()`) at a frame width; null when it does not fit at scale ≥ 1. */
function treeSvgTB(t: DesignTokens, root: PlotNode, frame: number, wkey: string, wname: string): string | null {
  const g = treeGeom(t);
  const c = cut(root, 0);
  const h = hierarchy<Cut>(c, (d) => d.kids);
  const specs = new Map<Cut, BoxSpec>();
  const all: Cut[] = [];
  const walk = (d: Cut) => {
    all.push(d);
    specs.set(d, spec(t, g, d));
    d.kids.forEach(walk);
  };
  walk(c);
  const maxH = Math.max(...all.map((d) => specs.get(d)!.h));
  const dy = maxH + g.gapY;
  const laid = tree<Cut>()
    .nodeSize([g.boxW + g.gapX, dy])
    .separation(() => 1)(h);
  const nodes = laid.descendants();
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const need = maxX - minX + g.boxW + 2 * g.margin;
  if (need > frame) return null;
  const W = frame;
  const depth = Math.max(...nodes.map((n) => n.depth));
  const H = g.margin * 2 + depth * dy + maxH;
  const cx = (x: number) => x - (minX + maxX) / 2 + W / 2;
  const top = (d: number) => g.margin + d * dy;
  const links = laid
    .links()
    .map((l) => {
      const ps = specs.get(l.source.data)!;
      const x1 = cx(l.source.x);
      const y1 = top(l.source.depth) + ps.h;
      const x2 = cx(l.target.x);
      const y2 = top(l.target.depth);
      const ym = y2 - g.gapY / 2;
      return `<path class="fig-b__link" d="M${fmt(x1)} ${fmt(y1)} V${fmt(ym)} H${fmt(x2)} V${fmt(y2)}"/>`;
    })
    .join("");
  const boxes = nodes.map((n) => boxSvg(t, g, n.data, specs.get(n.data)!, n.depth, cx(n.x) - g.boxW / 2, top(n.depth), g.boxW)).join("");
  return `${svgOpen(wkey, wname, frame, W, H, "tb")}${links}${boxes}</svg>`;
}

/**
 * Left→right tree (fallback when top→down does not fit): one column per depth (0..DEFAULT_DEPTH) sharing
 * the frame width, labels wrapped to the column width (≤ 4 lines). Leaves stack downward in data order; a
 * parent is centered on its children and, when it is taller than their span, its children's subtrees are
 * pushed down so nothing overlaps. Deterministic arithmetic over the cut tree; height is free.
 */
function treeSvgLR(t: DesignTokens, root: PlotNode, frame: number, wkey: string, wname: string): string {
  const g = treeGeom(t);
  const c = cut(root, 0);
  const depthOf = new Map<Cut, number>();
  let maxDepth = 0;
  const mark = (d: Cut, k: number) => {
    depthOf.set(d, k);
    maxDepth = Math.max(maxDepth, k);
    d.kids.forEach((x) => mark(x, k + 1));
  };
  mark(c, 0);
  const cols = maxDepth + 1;
  const colW = (frame - 2 * g.margin - (cols - 1) * g.gapX) / cols;
  const specs = new Map<Cut, BoxSpec>();
  for (const d of depthOf.keys()) specs.set(d, spec(t, g, d, colW, 4));
  const top = new Map<Cut, number>();
  const subtree = (d: Cut): Cut[] => [d, ...d.kids.flatMap(subtree)];
  const rowGap = g.gapY / 2;
  /** Places d's subtree starting at y = start; returns the subtree's bottom. */
  const place = (d: Cut, start: number): number => {
    const h = specs.get(d)!.h;
    if (!d.kids.length) {
      top.set(d, start);
      return start + h;
    }
    let cur = start;
    let bottom = start;
    for (const k of d.kids) {
      bottom = place(k, cur);
      cur = bottom + rowGap;
    }
    const first = d.kids[0]!;
    const last = d.kids[d.kids.length - 1]!;
    const center = (top.get(first)! + specs.get(first)!.h / 2 + top.get(last)! + specs.get(last)!.h / 2) / 2;
    let y = center - h / 2;
    if (y < start) {
      const delta = start - y;
      for (const k of d.kids.flatMap(subtree)) top.set(k, top.get(k)! + delta);
      bottom += delta;
      y = start;
    }
    top.set(d, y);
    return Math.max(bottom, y + h);
  };
  const H = place(c, g.margin) + g.margin;
  const left = (k: number) => g.margin + k * (colW + g.gapX);
  const links: string[] = [];
  const boxes: string[] = [];
  const draw = (d: Cut) => {
    const k = depthOf.get(d)!;
    const s = specs.get(d)!;
    const y = top.get(d)!;
    boxes.push(boxSvg(t, g, d, s, k, left(k), y, colW));
    for (const ch of d.kids) {
      const x1 = left(k) + colW;
      const y1 = y + s.h / 2;
      const y2 = top.get(ch)! + specs.get(ch)!.h / 2;
      const xm = x1 + g.gapX / 2;
      links.push(`<path class="fig-b__link" d="M${fmt(x1)} ${fmt(y1)} H${fmt(xm)} V${fmt(y2)} H${fmt(left(k + 1))}"/>`);
      draw(ch);
    }
  };
  draw(c);
  return `${svgOpen(wkey, wname, frame, frame, H, "lr")}${links.join("")}${boxes.join("")}</svg>`;
}

/** The tree for one width class: top→down when it fits at scale ≥ 1, else left→right. Always a tree. */
function treeSvg(t: DesignTokens, root: PlotNode, frame: number, wkey: string, wname: string): string {
  return treeSvgTB(t, root, frame, wkey, wname) ?? treeSvgLR(t, root, frame, wkey, wname);
}

function metaHtml(t: DesignTokens, n: PlotNode): string {
  const fk = n.factor_kind ? `<span class="fig-b__fk">${esc(FACTOR_LABEL[n.factor_kind])}</span>` : "";
  return `<span class="fig-b__lv">${esc(LEVEL_LABEL[n.level])}</span>${fk}<span class="fig-b__epi">${epHtml(t, n.epistemic)}</span>`;
}

/** S2 analysis prose (CP-026), labelled 「独自分析」 with the sfsh_analysis mark; shown under the summary. */
function analysisHtml(t: DesignTokens, n: PlotNode): string {
  return n.analysis ? `<p class="fig-b__analysis"><span class="fig-b__analysis-label">${epHtml(t, "sfsh_analysis")}</span>${esc(n.analysis)}</p>` : "";
}

function listItem(t: DesignTokens, n: PlotNode, depth: number): string {
  const head = `<span class="fig-b__name">${esc(n.label)}</span><span class="fig-b__tags">${metaHtml(t, n)}</span>`;
  if (!n.children.length && !n.summary && !n.analysis) return `<li class="fig-b__item" data-depth="${depth}"><div class="fig-b__leaf">${head}</div></li>`;
  const open = depth < DEFAULT_DEPTH ? " open" : "";
  const sum = n.summary ? `<p class="fig-b__summary">${esc(n.summary)}</p>` : "";
  const kids = n.children.length ? `<ul class="fig-b__ul">${n.children.map((c) => listItem(t, c, depth + 1)).join("")}</ul>` : "";
  return `<li class="fig-b__item" data-depth="${depth}"><details${open}><summary>${head}</summary>${sum}${analysisHtml(t, n)}${kids}</details></li>`;
}

function altTable(t: DesignTokens, root: PlotNode, idx: number): string {
  const rows: string[] = [];
  const walk = (n: PlotNode, parent: PlotNode | null, depth: number) => {
    rows.push(
      `<tr class="fig-b__row" data-depth="${depth}"><td>${esc(LEVEL_LABEL[n.level])}</td><td>${esc(n.factor_kind ? FACTOR_LABEL[n.factor_kind] : "—")}</td><th scope="row" class="fig-b__d${Math.min(depth, 6)}">${esc(n.label)}</th><td>${n.summary || !n.analysis ? esc(n.summary ?? "—") : ""}${analysisHtml(t, n)}</td><td>${esc(parent ? parent.label : "—")}</td><td>${epHtml(t, n.epistemic)}</td><td>${esc(n.grade)}</td></tr>`,
    );
    n.children.forEach((c) => walk(c, n, depth + 1));
  };
  walk(root, null, 0);
  return `<div class="fig-alt" data-alt-for="reverse-plot"><div class="fig-table-wrap"><table class="fig-table"><caption>結末${idx + 1}の因果の一覧（代替表示・全${rows.length}項目）</caption><thead><tr><th scope="col">階層</th><th scope="col">要因の種類</th><th scope="col">項目</th><th scope="col">説明</th><th scope="col">つながる先（結果）</th><th scope="col">認識区分</th><th scope="col">確度</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
}

function legend(t: DesignTokens): string {
  const lv = (["outcome", "direct", "factor", "root"] as const).map((k) => esc(LEVEL_LABEL[k])).join(" → ");
  const fk = (Object.keys(FACTOR_LABEL) as (keyof typeof FACTOR_LABEL)[]).map((k) => esc(FACTOR_LABEL[k])).join("・");
  const ep = (["canon", "consensus", "fan_theory", "sfsh_analysis"] as const).map((k) => `<li class="fig-legend__item">${epHtml(t, k)}</li>`).join("");
  return (
    `<ul class="fig-legend" aria-label="凡例">` +
    `<li class="fig-legend__item">階層: ${lv}（上または左が結果、下または右が原因）</li>` +
    `<li class="fig-legend__item">要因の種類: ${fk}</li>` +
    ep +
    `</ul>`
  );
}

export function renderReversePlot(viz: VizReversePlot, ctx: FigureContext): Raw | null {
  const t = ctx.tokens;
  const trees = viz.trees.filter((r) => r && r.label);
  if (!trees.length) return null;
  const classes = widthClasses(t).filter((c) => c.key !== "narrow");
  const parts = trees.map((root, i) => {
    const svgs = classes.map((c) => treeSvg(t, root, c.frame, c.key, c.name)).join("");
    const deeper = countDesc(root) > 0 ? "3階層目より下（根本原因など）と各項目の説明は、一覧を開いて読めます。" : "";
    return (
      `<figure class="fig-figure fig-b__fig" data-tree="${esc(root.id)}">` +
      `<figcaption class="fig-caption">結末${i + 1}：${esc(root.label)}</figcaption>` +
      `<div class="fig-b__tree">${svgs}<p class="fig-note">木は深さ${DEFAULT_DEPTH}（要因）まで表示しています。${esc(deeper)}</p></div>` +
      `<ul class="fig-b__ul fig-b__list">${listItem(t, root, 0)}</ul>` +
      `</figure>` +
      altTable(t, root, i)
    );
  });
  const intro = `リバースプロット：結末を根にして、上から下へ（画面幅に収まらない木は左から右へ）「直接原因 → 要因 → 根本原因」とたどる木です。`;
  return raw(`<div class="fig-block fig-b" data-fig="reverse-plot"><p class="fig-caption">${esc(intro)}</p>${legend(t)}${parts.join("")}</div>`);
}
