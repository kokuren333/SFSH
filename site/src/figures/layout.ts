/**
 * Deterministic force layout for figure A (build time only; d3-force never ships to dist).
 *
 * d3-force does not respect the frame's aspect ratio (wp03 §4.4), so this module adds:
 *  1. an elliptical initial layout with the frame's aspect (nodes ordered by faction, then id → factions
 *     start adjacent and stay clustered through weak intra-faction links);
 *  2. aspect-biased centering (forceX stronger than forceY in a portrait frame, and vice versa);
 *  3. a rectangular collision force on node+label boxes (labels are wide; circles are not enough);
 *  4. fit-to-frame: anisotropic linear mapping of the centers into the frame, then a deterministic
 *     box-overlap removal with clamping; if overlaps remain, the frame grows taller (+15%) and is refitted.
 *     Height is free because the SVG scales with the frame WIDTH only.
 * Randomness: seeded LCG; fixed tick count; inputs sorted by id; coordinates rounded to 0.1px.
 */
import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { type Box, boxesOverlap, cmpStr, lcg, r1 } from "./common.ts";

export interface GNode {
  id: string;
  group: string;
  /** Half width of the node+label box. */
  halfW: number;
  /** Extent above the node center. */
  top: number;
  /** Extent below the node center (circle + label underneath). */
  bottom: number;
}

export interface GLink {
  source: string;
  target: string;
}

export interface GraphLayout {
  W: number;
  H: number;
  pos: Map<string, { x: number; y: number }>;
}

export interface LayoutOptions {
  /** Frame margin (inside the viewBox). */
  margin: number;
  /** Minimum gap between boxes. */
  gap: number;
  seed: number;
  ticks: number;
  /** Extra area to reserve (e.g. the edge labels of the busiest phase). */
  extraArea?: number;
}

interface SimNode {
  id: string;
  i: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

export function nodeBox(n: GNode, x: number, y: number): Box {
  return { x0: x - n.halfW, y0: y - n.top, x1: x + n.halfW, y1: y + n.bottom };
}

function rectCollide(nodes: SimNode[], g: GNode[], gap: number) {
  return (alpha: number) => {
    const k = 0.6 * Math.max(alpha, 0.1);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const ga = g[i]!;
        const gb = g[j]!;
        const ax = a.x + (a.vx ?? 0);
        const ay = a.y + (a.vy ?? 0);
        const bx = b.x + (b.vx ?? 0);
        const by = b.y + (b.vy ?? 0);
        const ox = Math.min(ax + ga.halfW, bx + gb.halfW) - Math.max(ax - ga.halfW, bx - gb.halfW) + gap;
        const oy = Math.min(ay + ga.bottom, by + gb.bottom) - Math.max(ay - ga.top, by - gb.top) + gap;
        if (ox <= 0 || oy <= 0) continue;
        if (ox < oy) {
          const d = (bx > ax || (bx === ax && i < j) ? 1 : -1) * ox * 0.5 * k;
          a.vx = (a.vx ?? 0) - d;
          b.vx = (b.vx ?? 0) + d;
        } else {
          const d = (by > ay || (by === ay && i < j) ? 1 : -1) * oy * 0.5 * k;
          a.vy = (a.vy ?? 0) - d;
          b.vy = (b.vy ?? 0) + d;
        }
      }
    }
  };
}

/** Number of overlapping box pairs (gap-aware). */
export function countOverlaps(g: GNode[], xs: number[], ys: number[], gap: number): number {
  let c = 0;
  for (let i = 0; i < g.length; i++)
    for (let j = i + 1; j < g.length; j++)
      if (boxesOverlap(nodeBox(g[i]!, xs[i]!, ys[i]!), nodeBox(g[j]!, xs[j]!, ys[j]!), gap - 0.5)) c++;
  return c;
}

function fitAndSeparate(g: GNode[], sx: number[], sy: number[], W: number, H: number, opt: LayoutOptions) {
  const n = g.length;
  const m = opt.margin;
  const maxHW = Math.max(...g.map((d) => d.halfW));
  const maxTop = Math.max(...g.map((d) => d.top));
  const maxBot = Math.max(...g.map((d) => d.bottom));
  const minX = Math.min(...sx);
  const maxX = Math.max(...sx);
  const minY = Math.min(...sy);
  const maxY = Math.max(...sy);
  const xLo = m + maxHW;
  const xHi = W - m - maxHW;
  const yLo = m + maxTop;
  const yHi = H - m - maxBot;
  const xs = sx.map((x) => (maxX - minX < 1e-9 ? W / 2 : xLo + ((x - minX) / (maxX - minX)) * Math.max(0, xHi - xLo)));
  const ys = sy.map((y) => (maxY - minY < 1e-9 ? H / 2 : yLo + ((y - minY) / (maxY - minY)) * Math.max(0, yHi - yLo)));
  const clamp = (i: number) => {
    const d = g[i]!;
    xs[i] = Math.min(Math.max(xs[i]!, m + d.halfW), W - m - d.halfW);
    ys[i] = Math.min(Math.max(ys[i]!, m + d.top), H - m - d.bottom);
  };
  for (let i = 0; i < n; i++) clamp(i);
  for (let iter = 0; iter < 400; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodeBox(g[i]!, xs[i]!, ys[i]!);
        const b = nodeBox(g[j]!, xs[j]!, ys[j]!);
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + opt.gap;
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + opt.gap;
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Prefer the cheaper axis, but in a frame that is full horizontally use the vertical axis.
        const atWallX =
          xs[i]! <= m + g[i]!.halfW + 0.01 || xs[i]! >= W - m - g[i]!.halfW - 0.01 || xs[j]! <= m + g[j]!.halfW + 0.01 || xs[j]! >= W - m - g[j]!.halfW - 0.01;
        if (ox < oy && !(atWallX && iter > 50)) {
          const d = (xs[j]! > xs[i]! || (xs[j] === xs[i] && i < j) ? 1 : -1) * (ox / 2 + 0.05);
          xs[i] = xs[i]! - d;
          xs[j] = xs[j]! + d;
        } else {
          const d = (ys[j]! > ys[i]! || (ys[j] === ys[i] && i < j) ? 1 : -1) * (oy / 2 + 0.05);
          ys[i] = ys[i]! - d;
          ys[j] = ys[j]! + d;
        }
        clamp(i);
        clamp(j);
      }
    }
    if (!moved) break;
  }
  return { xs, ys };
}

/**
 * Lay out `nodes` (any order; sorted by id here) inside a frame of width W. Returns the final frame height
 * (≥ W × aspect, grown if needed) and node centers rounded to 0.1px.
 */
export function layoutGraph(nodesIn: GNode[], linksIn: GLink[], W: number, aspect: number, opt: LayoutOptions): GraphLayout {
  const g = [...nodesIn].sort((a, b) => cmpStr(a.id, b.id));
  const n = g.length;
  const pos = new Map<string, { x: number; y: number }>();
  if (n === 0) return { W, H: Math.round(W * aspect), pos };
  const index = new Map(g.map((d, i) => [d.id, i]));
  const links = linksIn
    .filter((l) => index.has(l.source) && index.has(l.target) && l.source !== l.target)
    .map((l) => (cmpStr(l.source, l.target) <= 0 ? l : { source: l.target, target: l.source }))
    .sort((a, b) => cmpStr(a.source, b.source) || cmpStr(a.target, b.target))
    .filter((l, i, arr) => i === 0 || l.source !== arr[i - 1]!.source || l.target !== arr[i - 1]!.target);

  // Frame height: preferred aspect, but at least ~2.6× the summed node box area + 3.5× the extra (label) area.
  const area = g.reduce((s, d) => s + (2 * d.halfW + opt.gap) * (d.top + d.bottom + opt.gap), 0);
  let H = Math.ceil(Math.max(W * aspect, (area * 2.6 + (opt.extraArea ?? 0) * 3.5) / W));
  const a = H / W;

  // 1. Elliptical initial layout ordered by (group, id).
  const order = g.map((d, i) => i).sort((p, q) => cmpStr(g[p]!.group, g[q]!.group) || cmpStr(g[p]!.id, g[q]!.id));
  const sim: SimNode[] = g.map((d, i) => ({ id: d.id, i, x: W / 2, y: H / 2 }));
  order.forEach((gi, k) => {
    if (n === 1) return;
    const t = -Math.PI / 2 + (2 * Math.PI * k) / n;
    sim[gi]!.x = W / 2 + W * 0.38 * Math.cos(t);
    sim[gi]!.y = H / 2 + H * 0.38 * Math.sin(t);
  });

  // 2. Forces.
  const L = Math.sqrt((W * H) / n) * 0.75;
  type SL = { source: string; target: string; d: number; s: number };
  const all: SL[] = links.map((l) => ({ ...l, d: L, s: 0.25 }));
  const groups = new Map<string, string[]>();
  for (const d of g) if (d.group) groups.set(d.group, [...(groups.get(d.group) ?? []), d.id]);
  for (const [, ids] of [...groups.entries()].sort((p, q) => cmpStr(p[0], q[0])))
    for (let k = 1; k < ids.length; k++) all.push({ source: ids[k - 1]!, target: ids[k]!, d: L * 0.8, s: 0.08 });

  const s = forceSimulation(sim).stop();
  s.randomSource(lcg(opt.seed));
  s.force(
    "link",
    forceLink<SimNode, SL>(all)
      .id((d) => d.id)
      .distance((l) => (l as SL).d)
      .strength((l) => (l as SL).s),
  );
  s.force("charge", forceManyBody().strength(-2.2 * L));
  s.force("x", forceX(W / 2).strength(0.07 * Math.sqrt(a)));
  s.force("y", forceY(H / 2).strength(0.07 / Math.sqrt(a)));
  s.force("box", rectCollide(sim, g, opt.gap));
  s.tick(opt.ticks);
  const sx = sim.map((d) => d.x);
  const sy = sim.map((d) => d.y);

  // 3. Fit to frame, separate, grow if needed.
  let fit = fitAndSeparate(g, sx, sy, W, H, opt);
  for (let grow = 0; grow < 16 && countOverlaps(g, fit.xs, fit.ys, opt.gap) > 0; grow++) {
    H = Math.ceil(H * 1.15);
    fit = fitAndSeparate(g, sx, sy, W, H, opt);
  }
  g.forEach((d, i) => pos.set(d.id, { x: r1(fit.xs[i]!), y: r1(fit.ys[i]!) }));
  return { W, H, pos };
}
