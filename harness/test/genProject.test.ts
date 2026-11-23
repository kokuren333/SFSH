import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PlotNode, PublicWork } from "../../site/src/public-types.ts";
import { checkPublicWork, forbiddenContent } from "../src/gen/check.ts";
import { loadGenreVocab } from "../src/gen/io.ts";
import { buildProjection, computeChainDropout, projectPublic } from "../src/gen/project.ts";
import { evaluatePublic } from "../src/nkg/publicRules.ts";
import type { Nkg, NkgNode } from "../src/nkg/types.ts";
import { fakePort } from "../src/nkg/testFixtures.ts";
import { EXCERPT_TEXT, HIDDEN_LABEL, INTERNAL_ANALYSIS, NON_PUBLIC, PUBLIC_ANALYSIS, genCards, genContext, genNkg, genValidation, genWork, makeGenWork } from "../src/gen/testFixtures.ts";

const noModel = (port: "luna" | "haiku") =>
  fakePort(port, (req) => {
    throw new Error(`projection must not call models (${req.task})`);
  });

function project(): PublicWork {
  const nkg = genNkg();
  return buildProjection({ nkg, validation: genValidation(nkg), cards: genCards(), work: genWork(), tags: ["school", "family"], genreVocab: loadGenreVocab() }).projection;
}

/** Independent deep scan (not the production checker) for internal keys / paths. */
function scanForbidden(v: unknown): string[] {
  const keys = new Set(["excerpts", "claim", "claims", "claim_refs", "provenance", "authored_by", "reviewed_by", "confidence", "basis", "raw_text_path", "review", "findings", "locator"]);
  const out: string[] = [];
  const walk = (x: unknown, at: string) => {
    if (typeof x === "string") {
      if (x.includes("research/raw")) out.push(at);
      return;
    }
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${at}[${i}]`));
    if (x && typeof x === "object")
      for (const [k, y] of Object.entries(x)) {
        // the only allowed "claim": interpretation position text (PublicWork contract)
        if (keys.has(k) && !(k === "claim" && /\.positions\[\d+\]$/.test(at))) out.push(`${at}.${k}`);
        walk(y, `${at}.${k}`);
      }
  };
  walk(v, "$");
  return out;
}

function allIds(pw: PublicWork): string[] {
  const ids: string[] = [];
  const walk = (n: PlotNode) => {
    ids.push(n.id);
    n.children.forEach(walk);
  };
  pw.viz.reverse_plot.trees.forEach(walk);
  ids.push(...pw.viz.relations.characters.map((c) => c.id), ...pw.viz.relations.relations.map((r) => r.id));
  ids.push(...(pw.viz.matrix?.secrets.map((s) => s.id) ?? []), ...(pw.viz.timeline?.events.map((e) => e.id) ?? []));
  ids.push(...pw.pages.themes.items.map((x) => x.id), ...pw.pages.context.items.map((x) => x.id), ...pw.pages.context.iconic.map((x) => x.id));
  ids.push(...pw.pages.interpretations.items.map((x) => x.id), ...pw.pages.quiz.map((x) => x.id));
  const el = pw.elements;
  ids.push(...[...el.events, ...el.motives, ...el.arcs, ...el.world_rules, ...el.setups, ...el.emotion_beats].map((x) => x.id));
  return ids;
}

test("projection: conforms to PublicWork, excludes non-eligible elements and every internal field (§2.6)", () => {
  const pw = project();
  assert.deepEqual(checkPublicWork(pw), []);
  assert.deepEqual(forbiddenContent(pw), []);
  assert.deepEqual(scanForbidden(pw), []);
  const ids = allIds(pw);
  for (const np of NON_PUBLIC) assert.equal(ids.includes(np), false, `${np} must not be projected`);
  const json = JSON.stringify(pw);
  for (const s of [HIDDEN_LABEL, INTERNAL_ANALYSIS, EXCERPT_TEXT, "非公開の秘密", "未確認の出来事", "根拠不足の要因", "非公開の問い", "非公開人物の動機", "claim:c0", "luna", "haiku", "T1×"]) assert.equal(json.includes(s), false, `leaked: ${s}`);
  // pages text is empty in the projection; quiz carries the public Quiz node display fields
  assert.deepEqual(pw.pages.overview, []);
  assert.deepEqual(pw.pages.figure_notes, { relations: null, reverse_plot: null, matrix: null });
  assert.deepEqual(pw.pages.quiz.map((q) => q.id), ["qz01"]);
  assert.deepEqual(pw.pages.quiz[0].based_on, ["wy01", "ev01"], "quiz refs filtered to projected ids (ch04 dropped; ev01 is a timeline element)");
});

test("projection: edges need both endpoints public (Knows holder 'audience' counts as public)", () => {
  const pw = project();
  const rels = pw.viz.relations.relations.map((r) => r.id);
  assert.deepEqual(rels.sort(), ["rl01", "rl02"], "rl03 (endpoint ch04 non-public), rl04 (faction), rl05 (not eligible) excluded");
  assert.ok(pw.viz.matrix);
  const cells = pw.viz.matrix.cells;
  assert.deepEqual(cells, [
    { secret: "se01", holder: "ch01", phase: "ph1", state: "suspects" },
    { secret: "se01", holder: "audience", phase: "ph2", state: "knows" },
  ]);
  assert.equal(pw.viz.matrix.secrets.some((s) => s.id === "se02"), false);
});

test("projection: relations' prominence ranking (degree desc, id asc), faction, changed_by_label", () => {
  const pw = project();
  assert.deepEqual(
    pw.viz.relations.characters.map((c) => [c.id, c.prominence]),
    [
      ["ch01", 1],
      ["ch02", 2],
      ["ch03", 3],
    ],
  );
  assert.equal(pw.viz.relations.characters.find((c) => c.id === "ch01")!.faction, "fa01");
  assert.equal(pw.viz.relations.characters.find((c) => c.id === "ch02")!.faction, null);
  const rl01 = pw.viz.relations.relations.find((r) => r.id === "rl01")!;
  assert.equal(rl01.changed_by_label, "裏切りの発覚");
  assert.equal(rl01.spoiler, "mid", "relation spoiler covers the changing event's spoiler");
  assert.equal(pw.viz.relations.relations.find((r) => r.id === "rl02")!.changed_by_label, null);
});

test("projection: reverse plot rooted at Outcome, levels from Why.level, cycle / non-public guarded, trees by size", () => {
  const pw = project();
  const shape = (n: PlotNode): unknown => [n.id, n.kind, n.level, n.factor_kind, n.children.map(shape)];
  assert.deepEqual(pw.viz.reverse_plot.trees.map(shape), [
    ["oc01", "outcome", "outcome", null, [["wy01", "why", "direct", "psychological", [["wy02", "why", "factor", "political", [["wy03", "why", "root", "social", []]]]]]]],
    ["oc02", "outcome", "outcome", null, [["wy05", "why", "direct", "psychological", []]]],
  ]);
  assert.equal(pw.viz.reverse_plot.trees[0].children[0].spoiler, "ending", "child spoiler covers the Explains edge spoiler");
});

test("projection: matrix audience column always present; timeline; header; gaps; sources limited to referenced ones", () => {
  const pw = project();
  const holders = pw.viz.matrix!.holders;
  assert.deepEqual(holders[holders.length - 1], { id: "audience", label: "読者", is_audience: true });
  assert.deepEqual(holders.map((h) => h.id), ["ch01", "audience"]);
  assert.deepEqual(pw.viz.timeline!.events.map((e) => e.id), ["ev01", "ev02", "ev03"]);

  const w = pw.work;
  assert.equal(w.title, "生成試験作品");
  assert.deepEqual(w.aliases_display, ["生成試験"], "attested only, title itself excluded");
  assert.deepEqual(w.genres, ["mystery"], "genres filtered by the controlled vocabulary");
  assert.deepEqual(w.tags, ["school", "family"]);
  assert.equal(w.status, "completed");
  assert.equal(w.coverage_label, "全体");
  assert.equal(w.spoiler_max, "ending");
  assert.equal(w.has_matrix, true);
  assert.equal(w.first_release_year, 2001);
  assert.deepEqual(pw.gaps, [{ module: "M09", aspect_label: "伏線と回収", reason: "insufficient_sources" }]);

  assert.deepEqual(pw.sources.map((s) => s.source_id), ["s000000001", "s000000002", "s000000003"], "unreferenced and non-public-only sources dropped");
  const s2 = pw.sources.find((s) => s.source_id === "s000000002")!;
  assert.deepEqual(s2, { source_id: "s000000002", title: "wiki.example の頁", publisher: "wiki.example", url: "https://wiki.example/page", accessed: "2026-11-20", tier: "T3", license: "CC BY-SA 4.0" });
  const ip = pw.pages.interpretations.items[0];
  assert.deepEqual(ip.positions.map((p) => p.source_refs), [["s000000003"], ["s000000003"]]);
  for (const c of pw.viz.relations.characters) for (const s of c.source_refs) assert.ok(pw.sources.some((x) => x.source_id === s));
});

test("projection: M05 off → no matrix; M04 off → no timeline", () => {
  const nkg = genNkg();
  nkg.work.module_selection = nkg.work.module_selection.filter((m) => m.module !== "M05" && m.module !== "M04");
  const pw = buildProjection({ nkg, validation: genValidation(nkg), cards: genCards(), work: genWork(), tags: [], genreVocab: loadGenreVocab() }).projection;
  assert.equal(pw.viz.matrix, null);
  assert.equal(pw.viz.timeline, null);
  assert.equal(pw.work.has_matrix, false);
  assert.deepEqual(checkPublicWork(pw), []);
});

test("projectPublic: deterministic (byte-identical twice), no model calls, writes gen/projection.json", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genp-"));
  try {
    const dir = makeGenWork(root);
    const ctx = genContext(dir, noModel("luna"), noModel("haiku"));
    const r1 = await projectPublic(ctx);
    const a = readFileSync(path.join(dir, "gen", "projection.json"));
    const r2 = await projectPublic(ctx);
    const b = readFileSync(path.join(dir, "gen", "projection.json"));
    assert.ok(a.equals(b));
    assert.deepEqual(r1.metrics, r2.metrics);
    assert.equal(r1.metrics.sources_kept, 3);
    assert.equal(r1.metrics.sources_total, 5);
    assert.deepEqual(r1.outputs, ["gen/projection.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CP-026: factions referenced by characters, analysis on plot / theme / context / iconic, character spoiler covers faction membership", () => {
  const pw = project();
  assert.deepEqual(pw.viz.relations.factions, [{ id: "fa01", label: "組織" }]);
  const ch01 = pw.viz.relations.characters.find((c) => c.id === "ch01")!;
  assert.equal(ch01.faction, "fa01");
  assert.equal(ch01.spoiler, "mid", "membership edge rl04 is mid");
  assert.equal(pw.viz.reverse_plot.trees[0].children[0].analysis, "崩壊の読み解き。");
  assert.equal(pw.viz.reverse_plot.trees[1].analysis, null);
  assert.equal(pw.pages.themes.items[0].analysis, PUBLIC_ANALYSIS);
  assert.equal(pw.pages.context.items[0].analysis, null);
  assert.equal("analysis" in ch01, false, "characters have no analysis field");
  assert.equal(JSON.stringify(pw).includes(INTERNAL_ANALYSIS), false);
});

test("CP-026: elements — public only, cross-refs from public edges with both endpoints present, sorted, spoiler raised by displayed edges", () => {
  const pw = project();
  const el = pw.elements;
  assert.deepEqual(el.events.map((e) => [e.id, e.story_order]), [["ev01", 1], ["ev02", 2], ["ev03", 3]], "story_order then id; ev04 non-public");
  const ev = Object.fromEntries(el.events.map((e) => [e.id, e]));
  assert.deepEqual(ev.ev01.caused_by, []);
  assert.deepEqual(ev.ev01.leads_to, [{ event: "ev02", kind: "causes" }], "cs04 (not eligible) excluded");
  assert.deepEqual(ev.ev02.caused_by, [{ event: "ev01", kind: "causes" }]);
  assert.deepEqual(ev.ev02.leads_to, [{ event: "ev03", kind: "enables" }], "cs03 (non-public ev04) excluded");
  assert.equal(ev.ev02.spoiler, "ending", "raised by the displayed Causes edge cs02");
  assert.equal(ev.ev01.spoiler, "mid", "own spoiler; referenced elements do not raise it");
  assert.equal(ev.ev01.phase_ref, null);

  assert.deepEqual(el.motives.map((m) => [m.id, m.owner]), [["mo01", "ch01"], ["mo02", "ch02"]], "owner prominence order; mo03 (non-public owner) excluded");
  assert.deepEqual(el.motives[0].drives, ["ev01"], "dr02 → non-public ev04 excluded");
  assert.deepEqual(el.motives[0].conflicts_with, ["mo02"], "cw02 → mo03 (not shown) excluded");
  assert.deepEqual(el.motives[1].conflicts_with, ["mo01"], "ConflictsWith is symmetric");
  assert.equal(el.motives[0].analysis, "動機の分析。");
  assert.deepEqual(el.arcs.map((a) => [a.id, a.turns_at, a.spoiler]), [["ar01", ["ev03"], "ending"]]);
  assert.deepEqual(el.world_rules.map((w) => [w.id, w.constrains]), [["wr01", ["ch01", "ev02"]]]);
  assert.deepEqual(el.setups.map((x) => [x.id, x.pays_off, x.spoiler]), [["su01", ["ev03"], "ending"]]);
  assert.deepEqual(el.emotion_beats.map((b) => [b.id, b.evoked_by, b.phase, b.intensity]), [["eb01", ["ev01", "ev02"], "ph2", 3]], "Evokes ∪ cause_refs, non-present refs dropped");
  for (const x of [...el.events, ...el.motives, ...el.arcs]) for (const s of x.source_refs) assert.ok(pw.sources.some((p) => p.source_id === s));
});

// ---------------------------------------------------------------- chain dropout (CP-029 ruling 2 note)

/** Validation built with the real public rules (nkg/publicRules.ts), the same way validate.ts does. */
function realValidation(nkg: Nkg) {
  const elements: Record<string, { grade: string; public_eligible: boolean; reasons: string[] }> = {};
  const elig = evaluatePublic(nkg.nodes, nkg.edges);
  for (const el of [...nkg.nodes, ...nkg.edges]) elements[el.id] = { grade: el.meta.confidence.grade, public_eligible: elig.get(el.id)?.eligible ?? false, reasons: elig.get(el.id)?.reasons ?? [] };
  return { elements };
}
/** A small NKG: public ch01 / ev01 / wy01 / oc01 / ev03, a root Why wy09 failing its own condition, two sfsh_analysis dependents. */
function chainNkg(): Nkg {
  const nkg = genNkg();
  const tmpl = nkg.nodes.find((n) => n.id === "wy02")!; // sfsh_analysis Why, T1 provenance
  const keep = new Set(["ch01", "ev01", "wy01", "oc01", "ev03"]);
  const clone = (o: Partial<NkgNode> & { id: string }): NkgNode => ({ ...structuredClone(tmpl), ...o }) as NkgNode;
  nkg.nodes = [
    ...nkg.nodes.filter((n) => keep.has(n.id)),
    clone({ id: "wy09", label: "根の要因", based_on: [] }), // sfsh_analysis with no based_on -> own failure
    clone({ id: "wy10", label: "派生の要因", based_on: ["wy09", "ev01"] }), // drops only because of wy09
    { ...structuredClone(nkg.nodes.find((n) => n.id === "th01")!), id: "th09", based_on: ["wy10"] } as NkgNode, // transitively
  ];
  const ch09 = { ...structuredClone(nkg.nodes.find((n) => n.id === "ch01")!), id: "ch09" } as NkgNode; // canon, fails its own grade, no dependents
  ch09.meta.confidence.grade = "D";
  nkg.nodes.push(ch09);
  nkg.edges = nkg.edges.filter((e) => ["xp01", "cs04"].includes(e.id));
  return nkg;
}

test("chain dropout: root Why fails its own condition → its two sfsh_analysis dependents are counted (not the root, not unrelated own failures)", () => {
  const nkg = chainNkg();
  const validation = realValidation(nkg);
  // preconditions from the real public rules
  assert.equal(validation.elements.wy09.public_eligible, false);
  assert.deepEqual(validation.elements.wy09.reasons, ["sfsh_analysis requires based_on"]);
  assert.equal(validation.elements.wy10.public_eligible, false);
  assert.equal(validation.elements.th09.public_eligible, false);
  assert.equal(validation.elements.ch09.public_eligible, false, "own failure without dependents");
  assert.equal(validation.elements.wy01.public_eligible, true);

  const res = buildProjection({ nkg, validation, cards: genCards(), work: genWork(), tags: [], genreVocab: loadGenreVocab() });
  assert.deepEqual(res.chainDropout, {
    count: 2,
    by_type: { Theme: 1, Why: 1 },
    roots: [{ root_id: "wy09", root_type: "Why", own_reason: "sfsh_analysis requires based_on", dependents: 2 }],
  });
  // the projection itself is untouched: no extra key, dropped elements absent, shape valid
  assert.equal("chain_dropout" in res.projection, false);
  assert.deepEqual(checkPublicWork(res.projection), []);
  const json = JSON.stringify(res.projection);
  for (const id of ["wy09", "wy10", "th09", "ch09"]) assert.equal(json.includes(`"${id}"`), false, id);
});

test("chain dropout: edges (endpoint gate / sfsh_analysis edges), cycles are own failures, roots ordered by dependents", () => {
  // the gen fixture: ev04 / ch04 / se02 fail their own condition; wy04 / qz02 hang on ev04
  const nkg = genNkg();
  const cd = computeChainDropout(nkg, genValidation(nkg));
  assert.equal(cd.count, 8);
  assert.deepEqual(cd.by_type, { Causes: 1, Drives: 1, Explains: 1, Knows: 2, Quiz: 1, Relation: 1, Why: 1 });
  assert.deepEqual(
    cd.roots.map((r) => [r.root_id, r.root_type, r.dependents]),
    [
      ["ev04", "Event", 5],
      ["ch04", "Character", 2],
      ["se02", "Secret", 1],
    ],
  );
  assert.match(cd.roots[0].own_reason, /^canon condition not met \(grade [A-E]\)$/);
  // rl05 / cs04 (own grade failures with public endpoints) are not counted; neither is kn01 (audience holder)

  // a based_on cycle of sfsh_analysis nodes is an own failure; a node hanging on it is chain dropout
  const c = chainNkg();
  const wy = c.nodes.find((n) => n.id === "wy10")!;
  c.nodes.push(
    { ...structuredClone(wy), id: "wy11", based_on: ["wy12"] },
    { ...structuredClone(wy), id: "wy12", based_on: ["wy11"] },
    { ...structuredClone(wy), id: "wy13", based_on: ["wy11", "ev01"] },
  );
  const v = realValidation(c);
  assert.equal(v.elements.wy11.public_eligible, false);
  assert.equal(v.elements.wy13.public_eligible, false);
  const cd2 = computeChainDropout(c, v);
  assert.equal(cd2.count, 3, "wy10, th09, wy13");
  assert.deepEqual(
    cd2.roots.map((r) => [r.root_id, r.dependents, r.own_reason]),
    [
      ["wy09", 2, "sfsh_analysis requires based_on"],
      ["wy11", 1, "based_on cycle"],
    ],
  );
});

test("projectPublic: chain_dropout written to gen/projection.json with a warning; existing projection fields unchanged", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genp-cd-"));
  try {
    const dir = makeGenWork(root);
    const r = await projectPublic(genContext(dir, noModel("luna"), noModel("haiku")));
    const file = JSON.parse(readFileSync(path.join(dir, "gen", "projection.json"), "utf8"));
    assert.equal(file.chain_dropout.count, 8);
    assert.equal(file.chain_dropout.roots[0].root_id, "ev04");
    assert.equal(r.metrics.chain_dropout, 8);
    assert.ok(r.warnings.includes("chain dropout: 8 element(s) excluded because their root(s) are not public-eligible"));
    const { chain_dropout: _cd, ...rest } = file;
    const nkg0 = genNkg();
    const expected = buildProjection({ nkg: nkg0, validation: genValidation(nkg0), cards: genCards(), work: genWork(), tags: [], genreVocab: loadGenreVocab() }).projection;
    assert.deepEqual(rest, JSON.parse(JSON.stringify(expected)), "projection fields identical to buildProjection's PublicWork");
    assert.deepEqual(checkPublicWork(rest), []);

    // nothing hangs on a non-eligible element → count 0, no warning
    const val = JSON.parse(readFileSync(path.join(dir, "nkg", "validation.json"), "utf8"));
    for (const id of Object.keys(val.elements)) val.elements[id].public_eligible = true;
    writeFileSync(path.join(dir, "nkg", "validation.json"), JSON.stringify(val));
    const r2 = await projectPublic(genContext(dir, noModel("luna"), noModel("haiku")));
    assert.equal(JSON.parse(readFileSync(path.join(dir, "gen", "projection.json"), "utf8")).chain_dropout.count, 0);
    assert.equal(r2.warnings.some((w) => w.startsWith("chain dropout")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
