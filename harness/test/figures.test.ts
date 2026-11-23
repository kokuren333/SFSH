/**
 * WP-2.3 figures A/B/C/timeline (site/src/figures). Output is parsed with regexes (no DOM dependency).
 * Fixture: site/fixtures/figures/viz.json (synthetic, fictional).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DesignTokens } from "../../site/src/design/tokens-types.ts";
import type { PlotNode, PublicPhase, VizMatrix, VizRelations, VizReversePlot, VizTimeline } from "../../site/src/public-types.ts";
import { renderMatrix, renderRelations, renderReversePlot, renderTimeline } from "../../site/src/figures/index.ts";
import { type Box, boxesOverlap, inside, lcg, textWidth, widthClasses } from "../../site/src/figures/common.ts";
import { EDGE_LABEL_MAX, nodeGeom, nodeLabelBox } from "../../site/src/figures/relations.ts";
import { DEFAULT_COLUMNS } from "../../site/src/figures/matrix.ts";

const root = new URL("../../", import.meta.url);
const tokens: DesignTokens = JSON.parse(readFileSync(new URL("site/src/design/tokens.json", root), "utf8"));
interface Fixture {
  phases: PublicPhase[];
  viz: { relations: VizRelations; reverse_plot: VizReversePlot; matrix: VizMatrix; timeline: VizTimeline };
}
const fx: Fixture = JSON.parse(readFileSync(new URL("site/fixtures/figures/viz.json", root), "utf8"));
const ctx = { tokens, phases: fx.phases, workId: "fixture-work" };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function shuffle<T>(xs: T[], seed: number): T[] {
  const r = lcg(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const A = () => renderRelations(fx.viz.relations, ctx)!.__raw;
const B = () => renderReversePlot(fx.viz.reverse_plot, ctx)!.__raw;
const C = () => renderMatrix(fx.viz.matrix, ctx)!.__raw;
const T = () => renderTimeline(fx.viz.timeline, ctx)!.__raw;

interface Svg {
  cls: string;
  w: number;
  h: number;
  attrs: string;
  body: string;
}
function svgs(html: string, kind: string): Svg[] {
  const out: Svg[] = [];
  const re = /<svg class="([^"]*)" viewBox="0 0 ([\d.]+) ([\d.]+)"([^>]*)>([\s\S]*?)<\/svg>/g;
  for (const m of html.matchAll(re)) if (m[1]!.includes(kind)) out.push({ cls: m[1]!, w: +m[2]!, h: +m[3]!, attrs: m[4]!, body: m[5]! });
  return out;
}
const attr = (s: string, name: string) => s.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

interface ANode {
  id: string;
  x: number;
  y: number;
  r: number;
  label: string;
}
function aNodes(body: string): ANode[] {
  const re =
    /<g class="fig-a__node" data-id="([^"]+)">(?:<title>[^<]*<\/title>)?<circle class="fig-a__dot" cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)"\/><rect[^>]*\/><text class="fig-a__nlabel"[^>]*>([^<]*)<\/text><\/g>/g;
  return [...body.matchAll(re)].map((m) => ({ id: m[1]!, x: +m[2]!, y: +m[3]!, r: +m[4]!, label: unesc(m[5]!) }));
}
interface AGroup {
  phase: string;
  pi: number;
  body: string;
}
function aGroups(body: string): AGroup[] {
  const start = body.indexOf('<g class="fig-a__phases">');
  const end = body.indexOf('<g class="fig-a__nodes">');
  assert.ok(start >= 0 && end > start, "phases container precedes nodes container");
  const inner = body.slice(start, end);
  return inner
    .split('<g class="fig-ph')
    .slice(1)
    .map((chunk) => ({ phase: attr(chunk, "data-phase")!, pi: +attr(chunk, "data-pi")!, body: chunk }));
}
interface AEdge {
  rel: string;
  change: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
function aEdges(body: string): AEdge[] {
  const re = /<path class="fig-a__edge[^"]*" data-rel="([^"]+)"(?: data-change="(\w+)")? d="M(-?[\d.]+) (-?[\d.]+) Q-?[\d.]+ -?[\d.]+ (-?[\d.]+) (-?[\d.]+)"/g;
  return [...body.matchAll(re)].map((m) => ({ rel: m[1]!, change: m[2] ?? null, x1: +m[3]!, y1: +m[4]!, x2: +m[5]!, y2: +m[6]! }));
}

// ------------------------------------------------------------------------------------------------ general

test("determinism: identical input → byte-identical output (A, B, C, timeline)", () => {
  assert.equal(A(), A());
  assert.equal(B(), B());
  assert.equal(C(), C());
  assert.equal(T(), T());
});

test("determinism: shuffled input order → identical output (A characters/relations, C cells, timeline events)", () => {
  for (const seed of [1, 7, 42]) {
    const r = clone(fx.viz.relations);
    r.characters = shuffle(r.characters, seed);
    r.relations = shuffle(r.relations, seed + 1);
    assert.equal(renderRelations(r, { ...ctx, phases: shuffle(fx.phases, seed) })!.__raw, A());
    const m = clone(fx.viz.matrix);
    m.cells = shuffle(m.cells, seed);
    assert.equal(renderMatrix(m, { ...ctx, phases: shuffle(fx.phases, seed + 2) })!.__raw, C());
    const tl = clone(fx.viz.timeline);
    tl.events = shuffle(tl.events, seed);
    assert.equal(renderTimeline(tl, ctx)!.__raw, T());
  }
});

test("every figure is followed immediately by its alternative table/list", () => {
  for (const [name, html, n] of [
    ["A", A(), 1],
    ["B", B(), fx.viz.reverse_plot.trees.length],
    ["C", C(), 1],
    ["T", T(), 1],
  ] as const) {
    const figs = html.match(/<\/figure>/g) ?? [];
    const followed = html.match(/<\/figure><div class="fig-alt" data-alt-for="[^"]+">/g) ?? [];
    assert.equal(figs.length, n, `${name}: figure count`);
    assert.equal(followed.length, n, `${name}: each </figure> is followed by .fig-alt`);
    assert.match(html, /<div class="fig-alt"[^>]*>(?:<p class="fig-alt__title">[^<]*<\/p>)?(?:<div class="fig-table-wrap"><table|<details)/, `${name}: alt is a table or list`);
  }
});

test("no <img>, no http(s), no xmlns, no inline style, no script in any output", () => {
  for (const html of [A(), B(), C(), T()]) {
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /https?:/i);
    assert.doesNotMatch(html, /\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    assert.doesNotMatch(html, /xmlns/);
    assert.doesNotMatch(html, /\sstyle=/);
    assert.doesNotMatch(html, /<script|on[a-z]+=/i);
  }
});

test("escaping: a label containing <b>&\" is escaped everywhere (A, B, C, timeline)", () => {
  const evil = '<b>&"x';
  const r = clone(fx.viz.relations);
  r.characters[0]!.label = evil;
  r.relations[0]!.kind = evil;
  r.relations[0]!.changed_by_label = evil;
  const p = clone(fx.viz.reverse_plot);
  p.trees[0]!.label = evil;
  p.trees[0]!.summary = evil;
  const m = clone(fx.viz.matrix);
  m.secrets[0]!.label = evil;
  m.holders[0]!.label = evil;
  const tl = clone(fx.viz.timeline);
  tl.events[0]!.label = evil;
  const phases = clone(fx.phases);
  phases[0]!.label = evil;
  const c2 = { ...ctx, phases };
  for (const html of [
    renderRelations(r, c2)!.__raw,
    renderReversePlot(p, c2)!.__raw,
    renderMatrix(m, c2)!.__raw,
    renderTimeline(tl, c2)!.__raw,
  ]) {
    assert.doesNotMatch(html, /<b>/);
    assert.doesNotMatch(html, /&"x/);
    assert.match(html, /&lt;b&gt;&amp;&quot;x/);
  }
});

test("min font scale: figure text ≥ 13px at every width class' minimum frame width", () => {
  const small = tokens.font.size.small;
  const classes = new Map(widthClasses(tokens).map((c) => [c.key, c]));
  let n = 0;
  for (const html of [A(), B(), T()]) {
    for (const s of svgs(html, "fig-svg")) {
      const minFrame = Number(attr(s.attrs, "data-min-frame"));
      const wclass = attr(s.attrs, "data-wclass")!;
      const cls = classes.get(wclass as "narrow")!;
      assert.ok(cls, `known width class ${wclass}`);
      assert.equal(minFrame, cls.frame);
      assert.equal(minFrame, cls.minViewport - 2 * tokens.layout.gutter, "frame = min viewport − 2 × gutter");
      const px = (small * minFrame) / s.w;
      assert.ok(px >= 13, `${wclass}: rendered ${px.toFixed(2)}px ≥ 13`);
      n++;
    }
  }
  assert.ok(n >= 9);
  // width classes follow the token breakpoints
  assert.deepEqual(
    widthClasses(tokens).map((c) => c.minViewport),
    [360, tokens.breakpoint.tablet, tokens.breakpoint.pc],
  );
});

test("null when there is nothing public to draw", () => {
  assert.equal(renderRelations({ characters: [], relations: [], factions: [] }, ctx), null);
  assert.equal(renderRelations({ characters: fx.viz.relations.characters, relations: [], factions: [] }, ctx), null);
  assert.equal(renderReversePlot({ trees: [] }, ctx), null);
  assert.equal(renderMatrix({ secrets: [], holders: fx.viz.matrix.holders, cells: [] }, ctx), null);
  assert.equal(renderTimeline({ events: [] }, ctx), null);
});

// ------------------------------------------------------------------------------------------------ figure A

test("A: three width-class SVGs per node set; default 12 (narrow 8) by prominence; 全員を表示 toggle", () => {
  const html = A();
  const all = svgs(html, "fig-a__svg");
  assert.equal(all.length, 6);
  const counts = all.map((s) => `${attr(s.attrs, "data-set")}:${attr(s.attrs, "data-wclass")}:${aNodes(s.body).length}`);
  assert.deepEqual(counts, ["main:narrow:8", "main:medium:12", "main:wide:12", "all:narrow:16", "all:medium:16", "all:wide:16"]);
  const top8 = aNodes(all[0]!.body)
    .map((n) => n.id)
    .sort();
  assert.deepEqual(top8, ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08"]);
  assert.match(html, /<label class="fig-toggle"><input class="fig-a__all" type="checkbox"><span>全員を表示（全16名）<\/span><\/label>/);
  assert.match(html, /class="fig-svg fig-a__svg fig-w--narrow"/);
  assert.match(html, /class="fig-svg fig-a__svg fig-w--medium"/);
  assert.match(html, /class="fig-svg fig-a__svg fig-w--wide"/);
  // narrow is portrait, wide is landscape
  assert.ok(all[0]!.h > all[0]!.w);
  assert.ok(all[2]!.h < all[2]!.w);
});

test("A: nodes drawn once outside the phase groups; edge endpoints = node centers in every phase", () => {
  for (const s of svgs(A(), "fig-a__svg")) {
    const nodes = aNodes(s.body);
    const ids = nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, "each node once");
    const groups = aGroups(s.body);
    assert.equal(groups.length, fx.phases.length);
    for (const g of groups) assert.doesNotMatch(g.body, /<circle/, "no node inside a phase group");
    const pos = new Map(nodes.map((n) => [n.id, n]));
    const rel = new Map(fx.viz.relations.relations.map((r) => [r.id, r]));
    for (const g of groups) {
      for (const e of aEdges(g.body)) {
        const r = rel.get(e.rel)!;
        assert.deepEqual([e.x1, e.y1], [pos.get(r.from)!.x, pos.get(r.from)!.y], `${g.phase} ${e.rel} from`);
        assert.deepEqual([e.x2, e.y2], [pos.get(r.to)!.x, pos.get(r.to)!.y], `${g.phase} ${e.rel} to`);
      }
    }
  }
});

test("A: every node inside the viewBox; no node label overlaps another label or node (all width classes, both sets)", () => {
  const g = nodeGeom(tokens);
  for (const s of svgs(A(), "fig-a__svg")) {
    const nodes = aNodes(s.body);
    const boxes: { id: string; kind: string; b: Box }[] = [];
    for (const n of nodes) {
      const dot = { x0: n.x - n.r, y0: n.y - n.r, x1: n.x + n.r, y1: n.y + n.r };
      const lab = nodeLabelBox(g, n.x, n.y, n.label);
      assert.ok(inside(dot, s.w, s.h), `${attr(s.attrs, "data-wclass")}: ${n.id} dot inside`);
      assert.ok(inside(lab, s.w, s.h), `${attr(s.attrs, "data-wclass")}: ${n.id} label inside`);
      boxes.push({ id: n.id, kind: "dot", b: dot }, { id: n.id, kind: "label", b: lab });
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.id === b.id) continue;
        if (a.kind === "dot" && b.kind === "dot") continue; // dots are inside the label-including node box anyway
        assert.ok(!boxesOverlap(a.b, b.b), `${attr(s.attrs, "data-wclass")}/${attr(s.attrs, "data-set")}: ${a.id}.${a.kind} vs ${b.id}.${b.kind}`);
      }
  }
});

test("A: default view (main set): edge labels overlap neither each other nor any node, in every phase and width class", () => {
  const g = nodeGeom(tokens);
  for (const s of svgs(A(), "fig-a__svg").filter((x) => attr(x.attrs, "data-set") === "main")) {
    const nodeBoxes = aNodes(s.body).flatMap((n) => [{ x0: n.x - n.r, y0: n.y - n.r, x1: n.x + n.r, y1: n.y + n.r }, nodeLabelBox(g, n.x, n.y, n.label)]);
    for (const grp of aGroups(s.body)) {
      const labs = [...grp.body.matchAll(/<g class="fig-a__elabel[^"]*" data-rel="([^"]+)"[^>]*><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => ({
        rel: m[1]!,
        b: { x0: +m[2]!, y0: +m[3]!, x1: +m[2]! + +m[4]!, y1: +m[3]! + +m[5]! },
      }));
      assert.ok(labs.length > 0);
      const where = `${attr(s.attrs, "data-wclass")}/${grp.phase}`;
      for (const l of labs) assert.ok(inside(l.b, s.w, s.h), `${where}: ${l.rel} inside`);
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) assert.ok(!boxesOverlap(labs[i]!.b, labs[j]!.b), `${where}: ${labs[i]!.rel} vs ${labs[j]!.rel}`);
        for (const nb of nodeBoxes) assert.ok(!boxesOverlap(labs[i]!.b, nb), `${where}: ${labs[i]!.rel} vs a node`);
      }
    }
  }
});

const ACTIVE: Record<string, string[]> = {
  ph1: ["r01", "r02", "r04", "r06", "r07", "r09", "r10", "r11", "r12", "r13", "r15", "r16", "r18", "r20", "r21", "r23"],
  ph2: ["r01", "r03", "r04", "r06", "r07", "r09", "r10", "r11", "r12", "r13", "r14", "r15", "r16", "r17", "r18", "r19", "r20", "r21", "r23"],
  ph3: ["r01", "r03", "r05", "r06", "r08", "r09", "r10", "r11", "r12", "r13", "r14", "r15", "r17", "r18", "r19", "r20", "r22", "r23", "r24"],
};
const CHANGES: Record<string, Record<string, string>> = {
  ph1: {},
  ph2: { r03: "changed", r14: "new", r17: "new", r19: "new" },
  ph3: { r05: "new", r08: "changed", r22: "new", r24: "new", r04: "ended", r16: "ended", r21: "ended" },
};

test("A: phase groups contain exactly the active relations (+ ended ones marked) and changes are marked per phase", () => {
  const wideAll = svgs(A(), "fig-a__svg").find((s) => attr(s.attrs, "data-set") === "all" && attr(s.attrs, "data-wclass") === "wide")!;
  for (const g of aGroups(wideAll.body)) {
    const edges = aEdges(g.body);
    const active = edges.filter((e) => e.change !== "ended").map((e) => e.rel).sort();
    assert.deepEqual(active, ACTIVE[g.phase], `${g.phase} active`);
    const ch = Object.fromEntries(edges.filter((e) => e.change).map((e) => [e.rel, e.change!]));
    assert.deepEqual(ch, CHANGES[g.phase], `${g.phase} changes`);
    // changed ones carry the accent underlay (new/changed) and a text marker "変化" in their label
    for (const [rel, kind] of Object.entries(CHANGES[g.phase]!)) {
      if (kind !== "ended") assert.match(g.body, new RegExp(`<path class="fig-a__hl" data-rel="${rel}"`));
      assert.match(g.body, new RegExp(`<g class="fig-a__elabel fig-a__elabel--changed" data-rel="${rel}" data-change="${kind}">.*?変化：`));
    }
  }
});

test("A: polarity = token color class + token dash + legend label; edge labels ≤ 10 chars, full text in the table", () => {
  const html = A();
  for (const v of ["positive", "negative", "ambivalent", "neutral"] as const) {
    const dash = tokens.semantic.valence[v].dash;
    const re = new RegExp(`<path class="fig-a__edge fig-val--${v}"[^>]*?(stroke-dasharray="([^"]*)")?/>`, "g");
    const ms = [...html.matchAll(re)];
    assert.ok(ms.length > 0, v);
    for (const m of ms) assert.equal(m[2] ?? "none", dash === "none" ? "none" : dash, `${v} dash`);
    assert.ok(html.includes(`<span>${tokens.semantic.valence[v].label}</span>`), `${v} legend label`);
  }
  for (const m of html.matchAll(/<text class="fig-a__kind"[^>]*>([^<]*)<\/text>/g)) assert.ok(Array.from(unesc(m[1]!)).length <= EDGE_LABEL_MAX, m[1]);
  assert.ok(html.includes("恋慕と不信の入り混…"), "long kind truncated visually");
  assert.ok(html.includes("<td>恋慕と不信の入り混じった複雑な感情</td>"), "full kind in the table");
});

test("A: phase switch = radios (no JS) with data-pi, first checked; one per phase", () => {
  const html = A();
  const radios = [...html.matchAll(/<label class="fig-switch__opt"><input class="fig-phase-radio" type="radio" name="fig-a-phase" value="([^"]+)" data-pi="(\d+)"( checked)?><span>([^<]+)<\/span><\/label>/g)];
  assert.deepEqual(
    radios.map((m) => [m[1], m[2], !!m[3], m[4]]),
    [
      ["ph1", "1", true, "序盤"],
      ["ph2", "2", false, "中盤"],
      ["ph3", "3", false, "終盤"],
    ],
  );
  assert.match(html, /^<div class="fig-block fig-a fig-phased"/);
  // a single phase needs no switch and its group is always visible
  const one = renderRelations(fx.viz.relations, { ...ctx, phases: [fx.phases[0]!] })!.__raw;
  assert.doesNotMatch(one, /fig-phase-radio/);
  assert.match(one, /<g class="fig-ph fig-ph--always" data-phase="ph1" data-pi="1">/);
});

test("A: alternative tables list every relation and every character", () => {
  const html = A();
  const alt = html.slice(html.indexOf('<div class="fig-alt"'));
  const relRows = alt.slice(0, alt.indexOf("</table>")).match(/<tr><td>/g) ?? [];
  assert.equal(relRows.length, fx.viz.relations.relations.length);
  for (const c of fx.viz.relations.characters) assert.ok(alt.includes(`<th scope="row">${c.label}</th>`), c.label);
  assert.ok(alt.includes("序盤〜序盤") === false, "single-phase interval shown once");
  assert.ok(alt.includes("<td>序盤</td>"));
  assert.ok(alt.includes("<td>中盤〜最後</td>"));
  assert.ok(alt.includes("<td>全期間</td>"));
  assert.ok(alt.includes("嵐の夜の救助"));
  assert.ok(alt.includes(`${tokens.semantic.epistemic.canon.mark}</span>${tokens.semantic.epistemic.canon.label}`));
});

test("A: 30 characters / 60 relations still lay out without node-label overlaps", () => {
  const chars = Array.from({ length: 30 }, (_, i) => ({
    id: `k${String(i).padStart(2, "0")}`,
    label: ["アルファ", "ベータ星", "ガンマ", "デルタ・ロング", "イプシロン"][i % 5]! + i,
    summary: null,
    faction: `f${i % 4}`,
    prominence: i + 1,
    epistemic: "canon" as const,
    grade: "B" as const,
    spoiler: "none" as const,
    source_refs: [],
  }));
  const r = lcg(99);
  const relations = Array.from({ length: 60 }, (_, i) => {
    const a = Math.floor(r() * 30);
    let b = Math.floor(r() * 30);
    if (b === a) b = (a + 1) % 30;
    return {
      id: `q${String(i).padStart(2, "0")}`,
      from: chars[a]!.id,
      to: chars[b]!.id,
      kind: "関係" + (i % 7),
      valence: (["positive", "negative", "ambivalent", "neutral"] as const)[i % 4],
      phase_from: i % 3 === 0 ? "ph2" : null,
      phase_to: i % 5 === 0 ? "ph2" : null,
      changed_by_label: null,
      epistemic: "canon" as const,
      grade: "B" as const,
      spoiler: "none" as const,
      source_refs: [],
    };
  });
  const t0 = performance.now();
  const html = renderRelations({ characters: chars, relations, factions: [] }, ctx)!.__raw;
  const ms = performance.now() - t0;
  const g = nodeGeom(tokens);
  for (const s of svgs(html, "fig-a__svg")) {
    const nodes = aNodes(s.body);
    for (const n of nodes) assert.ok(inside(nodeLabelBox(g, n.x, n.y, n.label), s.w, s.h));
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        assert.ok(!boxesOverlap(nodeLabelBox(g, a.x, a.y, a.label), nodeLabelBox(g, b.x, b.y, b.label)), `${a.id}/${b.id}`);
      }
  }
  assert.ok(ms < 5000, `render time ${ms.toFixed(0)}ms`);
});

// ------------------------------------------------------------------------------------------------ figure B

test("B: root is the Outcome; SVG tree draws depth ≤ 2; list opens depth < 2 (depth ≤ 2 visible); factor kinds and levels as text", () => {
  const html = B();
  const figs = html.split('<figure class="fig-figure fig-b__fig"').slice(1);
  assert.equal(figs.length, 2);
  for (const [i, f] of figs.entries()) {
    const rootLabel = fx.viz.reverse_plot.trees[i]!.label;
    for (const s of svgs(f, "fig-b__svg")) {
      const depth0 = [...s.body.matchAll(/<g class="fig-b__node fig-b__node--(\w+)" data-id="([^"]+)" data-depth="0">/g)];
      assert.equal(depth0.length, 1);
      assert.equal(depth0[0]![1], "outcome");
      const depths = [...s.body.matchAll(/data-depth="(\d+)"/g)].map((m) => +m[1]!);
      assert.ok(Math.max(...depths) <= 2, "svg depth ≤ 2");
      assert.ok(depths.includes(2));
    }
    // list form: first item is the outcome, open; depth 1 open; depth ≥ 2 closed
    const list = f.slice(f.indexOf('<ul class="fig-b__ul fig-b__list">'));
    assert.match(list, new RegExp(`^<ul class="fig-b__ul fig-b__list"><li class="fig-b__item" data-depth="0"><details open><summary><span class="fig-b__name">${rootLabel}</span>`));
    for (const m of list.matchAll(/<li class="fig-b__item" data-depth="(\d+)"><details( open)?>/g)) assert.equal(!!m[2], +m[1]! < 2, `depth ${m[1]} open=${!!m[2]}`);
  }
  for (const w of ["政治的", "心理的", "社会的", "偶然", "ルール", "直接原因", "要因", "根本原因", "結末"]) assert.ok(html.includes(w), w);
  // summary only inside details bodies (revealed on expansion), never in the SVG
  for (const s of svgs(html, "fig-b__svg")) assert.ok(!s.body.includes("長く続いた封鎖"), "summary not in svg");
  assert.match(html, /<\/summary><p class="fig-b__summary">長く続いた封鎖が終わり、船が戻る。<\/p>/);
});

test("B: a tree is always drawn at tablet and PC (top→down when it fits, else left→right); never a note only", () => {
  const html = B();
  assert.doesNotMatch(html, /fig-b__nofit/);
  const figs = html.split('<figure class="fig-figure fig-b__fig"').slice(1);
  for (const f of figs) {
    const ss = svgs(f, "fig-b__svg");
    assert.deepEqual(ss.map((s) => attr(s.attrs, "data-wclass")), ["medium", "wide"]);
  }
  // fixture tree 1 has 5 columns at depth 2 → too wide top→down for the tablet frame → left→right
  assert.deepEqual(svgs(figs[0]!, "fig-b__svg").map((s) => attr(s.attrs, "data-orient")), ["lr", "tb"]);
  assert.deepEqual(svgs(figs[1]!, "fig-b__svg").map((s) => attr(s.attrs, "data-orient")), ["tb", "tb"]);
  checkTreeSvgs(html);
});

/** Every node box inside the viewBox, no two boxes overlap, text lines inside their box, scale ≥ 13px. */
function checkTreeSvgs(html: string): void {
  const pad = tokens.space.xs;
  const f = tokens.font.size.small;
  for (const s of svgs(html, "fig-b__svg")) {
    const where = `${attr(s.attrs, "data-wclass")}/${attr(s.attrs, "data-orient")}`;
    assert.ok((f * Number(attr(s.attrs, "data-min-frame"))) / s.w >= 13, `${where}: scale`);
    const nodes = [...s.body.matchAll(/<g class="fig-b__node fig-b__node--(\w+)" data-id="([^"]+)" data-depth="(\d+)">(?:<title>[^<]*<\/title>)?<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>(.*?)<\/g>/g)];
    assert.ok(nodes.length > 0);
    assert.equal((s.body.match(/<path class="fig-b__link"/g) ?? []).length, nodes.length - 1, `${where}: one link per non-root node`);
    const boxes = nodes.map((m) => ({ id: m[2]!, depth: +m[3]!, b: { x0: +m[4]!, y0: +m[5]!, x1: +m[4]! + +m[6]!, y1: +m[5]! + +m[7]! }, texts: m[8]! }));
    assert.equal(boxes.filter((b) => b.depth === 0).length, 1);
    assert.ok(Math.max(...boxes.map((b) => b.depth)) <= 2, `${where}: depth ≤ 2`);
    for (const b of boxes) {
      assert.ok(inside(b.b, s.w, s.h), `${where}: ${b.id} inside`);
      for (const t of b.texts.matchAll(/<text class="[^"]+" x="(-?[\d.]+)" y="(-?[\d.]+)">([^<]*)<\/text>/g)) {
        const x = +t[1]!;
        const y = +t[2]!;
        assert.ok(x >= b.b.x0 && x + textWidth(unesc(t[3]!), f) <= b.b.x1 - pad + 0.1, `${where}: ${b.id} text "${t[3]}" fits the box width`);
        assert.ok(y - f >= b.b.y0 - 0.1 && y <= b.b.y1, `${where}: ${b.id} text inside the box height`);
      }
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) assert.ok(!boxesOverlap(boxes[i]!.b, boxes[j]!.b), `${where}: ${boxes[i]!.id} vs ${boxes[j]!.id}`);
  }
}

test("B: wide tree (2 outcomes × 6 direct × 3 factors, long labels) → left→right tree at tablet and PC, no overlaps, ≥13px", () => {
  const long = "とても長い説明的なラベルが付いた要因の名前その";
  const node = (id: string, level: PlotNode["level"], label: string, children: PlotNode[]): PlotNode => ({
    id,
    kind: level === "outcome" ? "outcome" : "why",
    level,
    factor_kind: level === "outcome" ? null : (["political", "psychological", "social", "chance", "rule"] as const)[id.length % 5]!,
    label,
    summary: null,
    analysis: null,
    epistemic: "canon",
    grade: "B",
    spoiler: "none",
    children,
  });
  const factor = (o: number, d: number, k: number) =>
    node(`o${o}d${d}f${k}`, "factor", `${long}${k}`, k === 0 ? [node(`o${o}d${d}f${k}r`, "root", `根本${long}`, [])] : []);
  const direct = (o: number, d: number) => node(`o${o}d${d}`, "direct", `直接原因${d}${long}`, [0, 1, 2].map((k) => factor(o, d, k)));
  const trees = [0, 1].map((o) => node(`o${o}`, "outcome", `結末${o}：${long}`, [0, 1, 2, 3, 4, 5].map((d) => direct(o, d))));
  const html = renderReversePlot({ trees }, ctx)!.__raw;
  assert.doesNotMatch(html, /fig-b__nofit/);
  const figs = html.split('<figure class="fig-figure fig-b__fig"').slice(1);
  assert.equal(figs.length, 2);
  for (const f of figs) {
    const ss = svgs(f, "fig-b__svg");
    assert.deepEqual(ss.map((s) => `${attr(s.attrs, "data-wclass")}:${attr(s.attrs, "data-orient")}`), ["medium:lr", "wide:lr"]);
    for (const s of ss) {
      assert.equal(s.w, Number(attr(s.attrs, "data-min-frame")), "viewBox width = class minimum frame (scale ≥ 1)");
      assert.equal((s.body.match(/data-depth="2"/g) ?? []).length, 18);
      assert.equal((s.body.match(/▼続き1件（一覧）/g) ?? []).length, 6, "deeper causes marked");
      assert.ok(s.h > s.w, "breadth grows downward");
    }
  }
  checkTreeSvgs(html);
  assert.equal(renderReversePlot({ trees }, ctx)!.__raw, html, "deterministic");
});

test("B: alternative table lists every node of every level", () => {
  const html = B();
  const count = (n: { children: unknown[] }): number => 1 + (n.children as { children: unknown[] }[]).reduce((s, c) => s + count(c), 0);
  const alts = [...html.matchAll(/<div class="fig-alt" data-alt-for="reverse-plot">([\s\S]*?)<\/table>/g)];
  assert.equal(alts.length, 2);
  alts.forEach((m, i) => assert.equal((m[1]!.match(/<tr class="fig-b__row"/g) ?? []).length, count(fx.viz.reverse_plot.trees[i]!)));
  assert.ok(html.includes("灯台守が代々記録を残す慣習"), "depth-3 node present");
});

// ------------------------------------------------------------------------------------------------ figure C

test("C: reader column distinguished and first; one column per holder; marks + labels; missing = 情報なし", () => {
  const html = C();
  const head = html.match(/<thead>([\s\S]*?)<\/thead>/)![1]!;
  const cols = [...head.matchAll(/<th scope="col"(?: class="([^"]*)")? data-holder="([^"]+)">([^<]*)<\/th>/g)];
  assert.equal(cols.length, fx.viz.matrix.holders.length);
  assert.equal(cols[0]![2], "audience");
  assert.equal(cols[0]![3], "読者");
  assert.ok(cols[0]![1]!.includes("fig-c__aud"));
  assert.deepEqual(
    cols.slice(1).map((c) => c[2]),
    fx.viz.matrix.holders.filter((h) => !h.is_audience).map((h) => h.id),
  );
  // default 8 visible columns (reader included); the rest are toggleable
  assert.equal(cols.filter((c) => (c[1] ?? "").includes("fig-c__col--extra")).length, fx.viz.matrix.holders.length - DEFAULT_COLUMNS);
  assert.match(html, /<input class="fig-c__allcols" type="checkbox"><span>すべての列を表示（全12列）<\/span>/);
  const rows = [...html.matchAll(/<tr data-secret="([^"]+)">([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, fx.viz.matrix.secrets.length);
  for (const r of rows) {
    const cells = [...r[2]!.matchAll(/<td class="fig-c__cell[^"]*" data-holder="[^"]+">([\s\S]*?)<\/td>/g)];
    assert.equal(cells.length, fx.viz.matrix.holders.length);
    for (const c of cells) assert.equal((c[1]!.match(/class="fig-ph" data-phase/g) ?? []).length, fx.phases.length);
  }
  // s1 × c03 × ph1 = knows → mark + label; s1 × c02 × ph1 missing → neutral mark
  const s1 = rows[0]![2]!;
  const k = tokens.semantic.know_state.knows;
  assert.ok(s1.includes(`<td class="fig-c__cell" data-holder="c03"><span class="fig-ph" data-phase="ph1" data-pi="1"><span class="fig-ks fig-ks--knows" role="img" aria-label="${k.label}">${k.mark}</span>`));
  assert.ok(s1.includes(`data-holder="c02"><span class="fig-ph" data-phase="ph1" data-pi="1"><span class="fig-ks fig-ks--none" role="img" aria-label="情報なし">・</span>`));
  assert.notEqual("・", tokens.semantic.know_state.unknown.mark, "missing mark differs from unknown");
  for (const s of ["knows", "suspects", "misbelieves", "unknown"] as const)
    assert.ok(html.includes(`<li class="fig-legend__item"><span class="fig-ks fig-ks--${s}" role="img" aria-label="${tokens.semantic.know_state[s].label}">${tokens.semantic.know_state[s].mark}</span><span>${tokens.semantic.know_state[s].label}</span></li>`), s);
});

test("C: scroll frame + cue + phase radios; alternative per-phase lists", () => {
  const html = C();
  assert.match(html, /<div class="fig-c__scroll" tabindex="0" role="region" aria-label="[^"]+"><table class="fig-c__table">/);
  assert.match(html, /<p class="fig-c__cue">/);
  assert.equal((html.match(/name="fig-c-phase"/g) ?? []).length, 3);
  assert.match(html, /^<div class="fig-block fig-c fig-phased"/);
  const alt = html.slice(html.indexOf('<div class="fig-alt" data-alt-for="matrix">'));
  assert.equal((alt.match(/<details class="fig-alt__phase"/g) ?? []).length, 3);
  assert.ok(alt.includes("<span class=\"fig-alt__secret\">倉庫の地下の抜け道</span>：読者＝疑っている、汐見カイ＝知らない、黒瀬ジン＝知っている、柳ハルト＝知っている、ほか8列は情報なし"));
  assert.ok(alt.includes("ハルトの密約</span>：すべての列で情報なし"));
});

// ------------------------------------------------------------------------------------------------ timeline

test("timeline: one line per event between the two axes; unknown disclosure grouped; table lists all", () => {
  const html = T();
  const s = svgs(html, "fig-t__svg");
  assert.equal(s.length, 3);
  for (const x of s) assert.equal((x.body.match(/<g class="fig-t__ev"/g) ?? []).length, fx.viz.timeline.events.length);
  assert.ok(html.includes("時期の記述なし"));
  assert.equal((html.match(/<tr><td>\d+<\/td>/g) ?? []).length, fx.viz.timeline.events.length);
});

// ------------------------------------------------------------------------------------------------ CSS + client

test("figures.css: token variables only, px only 0 / mq breakpoints, no forbidden decoration", async () => {
  const { mq, tokensToCss } = await import("../../site/src/design/tokensCss.ts");
  const css = readFileSync(new URL("site/src/styles/figures.css", root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set([...tokensToCss(tokens).matchAll(/(--[\w-]+):/g)].map((m) => m[1]!));
  for (const m of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(defined.has(m[1]!), `undefined var ${m[1]}`);
  const q = mq(tokens);
  for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) {
    const cond = m[1]!.trim();
    assert.ok(cond === q.tablet || cond === q.pc || cond === "(prefers-reduced-motion: reduce)", `media ${cond}`);
  }
  const noMedia = css.replace(/@media[^{]+\{/g, "");
  for (const m of noMedia.matchAll(/(-?\d*\.?\d+)px/g)) assert.equal(Number(m[1]), 0, `px literal ${m[0]}`);
  assert.doesNotMatch(css, /gradient|box-shadow|text-shadow|italic|oblique|url\(|@keyframes|animation/i);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, "no color literals");
  for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
    const durations = m[1]!.match(/\d*\.?\d+m?s\b/g) ?? [];
    assert.deepEqual(durations, [], "durations only via var(--motion-duration)");
    if (m[1] !== "none") assert.ok(m[1]!.includes("var(--motion-duration)"));
  }
  for (const prop of ["font-size", "font-weight", "line-height", "color", "fill", "stroke", "stroke-width", "border-radius"]) {
    for (const m of css.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`, "g"))) {
      const v = m[1]!.trim();
      assert.ok(/var\(--/.test(v) || v === "none" || v === "0" || v === "inherit", `${prop}: ${v}`);
    }
  }
  // D3/D4: stacked <summary> tap targets (B list items, C per-phase alternative) are ≥ 44px tall, ≥ 8px apart
  assert.match(css, /\.fig-b__item \{\s*margin: var\(--layout-tap-gap\) 0;/);
  assert.match(css, /\.fig-alt__phase \{\s*margin-block: var\(--layout-tap-gap\);/);
  assert.match(css, /\.fig-b__item summary,\s*\.fig-b__leaf \{[^}]*min-height: var\(--layout-tap\);/);
  assert.match(css, /\.fig-alt__phase summary \{[^}]*min-height: var\(--layout-tap\);/);
  // phase rules cover at least 20 phases
  for (let i = 1; i <= 20; i++) assert.ok(css.includes(`.fig-phase-radio[data-pi="${i}"]:checked) .fig-ph[data-pi="${i}"]`), `phase rule ${i}`);
});

test("phase.ts: DOM-only module without imports; reads and writes ?phase=", () => {
  const src = readFileSync(new URL("site/src/client/phase.ts", root), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.match(src, /searchParams\.get\("phase"\)/);
  assert.match(src, /searchParams\.set\("phase"/);
  assert.match(src, /history\.replaceState/);
  assert.match(src, /input\.fig-phase-radio/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|localStorage|document\.cookie/);
});

test("figures module: pure (no fs / network / clock / Math.random imports)", () => {
  for (const f of ["index.ts", "common.ts", "layout.ts", "relations.ts", "reversePlot.ts", "matrix.ts", "timeline.ts"]) {
    const src = readFileSync(new URL(`site/src/figures/${f}`, root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /["']node:|from "fs"|require\(|import\(|fetch\(|Math\.random|Date\.now|new Date|performance\./, f);
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.ok(/^\.\.?\//.test(m[1]!) || m[1] === "d3-force" || m[1] === "d3-hierarchy", `${f} imports ${m[1]}`);
  }
});

// ------------------------------------------------------------------------------------------------ CP-026

test("A: character table shows faction labels from viz.factions (no placeholder group names); unlabelled id is marked, never invented", () => {
  const html = A();
  const people = html.slice(html.indexOf("<caption>登場人物"));
  assert.match(people, /<th scope="col">所属<\/th>/);
  for (const f of fx.viz.relations.factions) assert.ok(people.includes(`<td>${f.label}</td>`), f.label);
  assert.match(people, /<tr><th scope="row">汐見カイ<\/th><td>港湾組合<\/td>/);
  assert.doesNotMatch(html, /グループ[A-Z]/);
  const v = clone(fx.viz.relations);
  v.factions = [{ id: "f_harbor", label: "<港>&組合" }];
  const out = renderRelations(v, ctx)!.__raw;
  assert.ok(out.includes("<td>&lt;港&gt;&amp;組合</td>"), "faction label escaped");
  assert.ok(out.includes("<td>所属あり（名称未掲載）</td>"), "unlabelled faction marked");
});

test("B: analysis shown under the summary inside the list details and in the table, labelled 独自分析 with its mark; escaped", () => {
  const html = B();
  const sa = tokens.semantic.epistemic.sfsh_analysis;
  const label = `<span class="fig-b__analysis-label"><span class="fig-ep fig-ep--sfsh-analysis" aria-hidden="true">${sa.mark}</span>${sa.label}</span>`;
  const text = "議長への個人的な失望が、派閥の利害より強く働いたと読める。";
  assert.ok(html.includes(`</summary><p class="fig-b__summary">古株の議員が議長に背を向けた。</p><p class="fig-b__analysis">${label}${text}</p>`));
  assert.ok(html.includes(`<td>古株の議員が議長に背を向けた。<p class="fig-b__analysis">${label}${text}</p></td>`));
  for (const s of svgs(html, "fig-b__svg")) assert.ok(!s.body.includes(text), "analysis not in svg");
  assert.equal(html.split('class="fig-b__analysis"').length - 1, 2, "only nodes with analysis get the paragraph");
  const p = clone(fx.viz.reverse_plot);
  const leaf = p.trees[0]!.children[2]!; // d3: no summary, no children
  leaf.analysis = '<script>x</script>"';
  const out = renderReversePlot(p, ctx)!.__raw;
  assert.ok(out.includes(`<li class="fig-b__item" data-depth="1"><details open><summary><span class="fig-b__name">${leaf.label}</span>`), "a leaf with analysis becomes expandable");
  assert.ok(out.includes("&lt;script&gt;x&lt;/script&gt;&quot;"));
  assert.doesNotMatch(out, /<script>x/);
});
