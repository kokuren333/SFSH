import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeConfidence, type TieredSource } from "../src/nkg/confidence.ts";
import { evaluatePublic } from "../src/nkg/publicRules.ts";
import { FIXTURE_SOURCES, fixtureMeta, fixtureNkg } from "../src/nkg/testFixtures.ts";
import type { NkgNode, ProvenanceItem } from "../src/nkg/types.ts";
import { validateNkg, writeValidation } from "../src/nkg/validate.ts";
import { NKG_SCHEMA_PATH, renderNkgSchema } from "../src/nkg/writeSchema.ts";

// ---------- confidence ----------
const src = (id: string, tier: TieredSource["tier"], site: string): TieredSource => ({ source_id: id, tier, site_key: site });
const prov = (...ids: string[]): ProvenanceItem[] => ids.map((source_id) => ({ source_id, locator: "x", support: "direct" }));
const map = (...s: TieredSource[]) => new Map(s.map((x) => [x.source_id, x] as const));

test("confidence: A paths", () => {
  assert.equal(computeConfidence(prov("a"), map(src("a", "T1", "x")), "agreed").grade, "A");
  assert.equal(computeConfidence(prov("a", "b"), map(src("a", "T2", "x"), src("b", "T2", "y")), "agreed").grade, "A");
  // higher tier counts toward lower thresholds: T1 site + T2 site trivially A; T2+T2 independent A
  const c = computeConfidence(prov("a"), map(src("a", "T1", "x")), "revised");
  assert.deepEqual(c, { score: 0.9, grade: "A", basis: "T1×1 (sites: 1)" });
});

test("confidence: independence — two T2 from the same site_key is B, not A", () => {
  const r = computeConfidence(prov("a", "b"), map(src("a", "T2", "x"), src("b", "T2", "x")), "agreed");
  assert.equal(r.grade, "B");
  assert.equal(r.basis, "T2×2 (sites: 1)");
});

test("confidence: B paths", () => {
  assert.equal(computeConfidence(prov("a"), map(src("a", "T2", "x")), "agreed").grade, "B");
  assert.equal(computeConfidence(prov("a", "b"), map(src("a", "T3", "x"), src("b", "T3", "y")), "agreed").grade, "B");
  assert.equal(computeConfidence(prov("a", "b"), map(src("a", "T2", "x"), src("b", "T3", "x")), "agreed").grade, "B");
  // two T3 on the same site is only C
  assert.equal(computeConfidence(prov("a", "b"), map(src("a", "T3", "x"), src("b", "T3", "x")), "agreed").grade, "C");
});

test("confidence: C paths", () => {
  assert.equal(computeConfidence(prov("a"), map(src("a", "T3", "x")), "agreed").grade, "C");
  assert.equal(computeConfidence(prov("a", "b"), map(src("a", "T4", "x"), src("b", "T4", "y")), "agreed").grade, "C");
  // distinct sources (not sites) suffice for the T4 rule
  assert.equal(computeConfidence(prov("a", "b"), map(src("a", "T4", "x"), src("b", "T4", "x")), "agreed").grade, "C");
});

test("confidence: D paths, T5-only never rises above D", () => {
  assert.equal(computeConfidence(prov("a"), map(src("a", "T4", "x")), "agreed").grade, "D");
  const r = computeConfidence(prov("a", "b", "c"), map(src("a", "T5", "x"), src("b", "T5", "y"), src("c", "T5", "z")), "agreed");
  assert.deepEqual(r, { score: 0.3, grade: "D", basis: "T5×3 (sites: 3)" });
  assert.equal(computeConfidence([], map(), "agreed").basis, "no sources (sites: 0)");
  assert.equal(computeConfidence(prov("missing"), map(), "agreed").grade, "D");
});

test("confidence: disputed lowers one step; D stays D; basis is deterministic", () => {
  const r = computeConfidence(prov("a", "b", "c"), map(src("a", "T1", "x"), src("b", "T3", "y"), src("c", "T3", "z")), "disputed");
  assert.deepEqual(r, { score: 0.7, grade: "B", basis: "T1×1, T3×2 (sites: 3); disputed −1" });
  assert.equal(computeConfidence(prov("a"), map(src("a", "T2", "x")), "disputed").grade, "C");
  assert.equal(computeConfidence(prov("a"), map(src("a", "T3", "x")), "disputed").grade, "D");
  assert.equal(computeConfidence(prov("a"), map(src("a", "T5", "x")), "disputed").grade, "D");
  // duplicated provenance entries for the same source count once
  assert.equal(computeConfidence([...prov("a"), ...prov("a")], map(src("a", "T4", "x")), "agreed").grade, "D");
});

// ---------- public rules ----------
function node(id: string, epistemic: "canon" | "consensus" | "fan_theory" | "sfsh_analysis", sources: string[], based_on: string[] = []): NkgNode {
  return { id, type: "Character", module: "M01", label: id, based_on, meta: fixtureMeta(sources, { epistemic }) };
}

test("public rules: canon B+, consensus C+, fan_theory needs provenance", () => {
  const r = evaluatePublic(
    [
      node("ca", "canon", ["s000000001"]),
      node("cb", "canon", ["s000000002"]), // T3 → C → not canon-eligible
      node("co", "consensus", ["s000000002"]),
      node("cd", "consensus", ["s000000003"]), // T4 → D
      node("ft", "fan_theory", ["s000000003"]),
    ],
    [],
  );
  assert.equal(r.get("ca")!.eligible, true);
  assert.equal(r.get("cb")!.eligible, false);
  assert.match(r.get("cb")!.reasons[0], /canon requires grade B/);
  assert.equal(r.get("co")!.eligible, true);
  assert.equal(r.get("cd")!.eligible, false);
  assert.equal(r.get("ft")!.eligible, true);
  const empty = node("fe", "fan_theory", []);
  assert.equal(evaluatePublic([empty], []).get("fe")!.eligible, false);
});

test("public rules: sfsh_analysis recursion and cycles", () => {
  const nodes = [
    node("ok1", "canon", ["s000000001"]),
    node("bad", "canon", ["s000000003"]),
    node("an1", "sfsh_analysis", ["s000000001"], ["ok1"]),
    node("an2", "sfsh_analysis", ["s000000001"], ["an1"]), // depth 2, eligible
    node("an3", "sfsh_analysis", ["s000000001"], ["an1", "bad"]), // one basis fails
    node("an4", "sfsh_analysis", ["s000000001"], []), // empty based_on
    node("cy1", "sfsh_analysis", ["s000000001"], ["cy2"]),
    node("cy2", "sfsh_analysis", ["s000000001"], ["cy1"]),
    node("cy3", "sfsh_analysis", ["s000000001"], ["ok1", "cy1"]), // depends on a cycle
    node("self", "sfsh_analysis", ["s000000001"], ["self"]),
  ];
  const r = evaluatePublic(nodes, []);
  assert.equal(r.get("an1")!.eligible, true);
  assert.equal(r.get("an2")!.eligible, true);
  assert.equal(r.get("an3")!.eligible, false);
  assert.equal(r.get("an4")!.eligible, false);
  assert.equal(r.get("cy1")!.eligible, false);
  assert.equal(r.get("cy2")!.eligible, false);
  assert.equal(r.get("cy3")!.eligible, false);
  assert.equal(r.get("self")!.eligible, false);
});

// ---------- validator ----------
test("schema file is in sync with schemaSource.ts", () => {
  assert.equal(readFileSync(NKG_SCHEMA_PATH, "utf8"), renderNkgSchema());
});

test("valid fixture NKG passes", () => {
  const v = validateNkg(fixtureNkg());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(v.elements.ch01.grade, "A");
  assert.equal(v.elements.ch01.public_eligible, true);
  assert.equal(v.elements.th01.public_eligible, true);
  assert.equal(v.elements.em01.public_eligible, true);
});

test("dangling refs fail", () => {
  const cases: [string, (n: ReturnType<typeof fixtureNkg>) => void, RegExp][] = [
    ["edge to", (n) => (n.edges[1].to = "ev99"), /dangling ref Causes:cs01\.to/],
    ["phase_ref", (n) => (n.nodes[2].meta.phase_ref = "ph9"), /dangling phase/],
    ["source", (n) => (n.nodes[0].meta.provenance[0].source_id = "s999"), /dangling source/],
    ["based_on", (n) => (n.nodes[4].based_on = ["zz01"]), /dangling ref Theme:th01\.based_on/],
    ["changed_by non-event", (n) => ((n.edges[0] as { changed_by: string | null }).changed_by = "ch02"), /must be Event/],
    ["duplicate id", (n) => (n.nodes[1].id = "ch01"), /duplicate id ch01/],
  ];
  for (const [name, mutate, re] of cases) {
    const n = fixtureNkg();
    mutate(n);
    const v = validateNkg(n);
    assert.equal(v.ok, false, name);
    assert.ok(v.errors.some((e) => re.test(e)), `${name}: ${v.errors.join(" | ")}`);
  }
});

test("authored_by === reviewed_by fails", () => {
  const n = fixtureNkg();
  n.nodes[0].meta.reviewed_by = "luna";
  const v = validateNkg(n);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /authored_by === reviewed_by/.test(e)));
});

test("empty provenance fails (schema minItems 1)", () => {
  const n = fixtureNkg();
  n.nodes[0].meta.provenance = [];
  n.nodes[0].meta.confidence = computeConfidence([], new Map(), "agreed");
  const v = validateNkg(n);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /provenance/.test(e) && /fewer than 1/.test(e)), v.errors.join(" | "));
});

test("stored confidence differing from recomputed fails", () => {
  const n = fixtureNkg();
  n.nodes[0].meta.confidence = { score: 0.7, grade: "B", basis: "x" };
  const v = validateNkg(n);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /recomputed A/.test(e)));
});

test("phases must be 3–7", () => {
  const n = fixtureNkg();
  n.work.phases = n.work.phases.slice(0, 2);
  assert.equal(validateNkg(n).ok, false);
});

// ---------- C-2 / C-3 guard ----------
const FORBIDDEN = /scene|dialog|line$|lines|quote|quotation|transcript|panel|frame|cut|shot|lyric|script|台詞|せりふ|場面|コマ|カット|描写|原文|引用|歌詞/i;

test("schema has no scene/dialogue/quotation/panel/original-text type, property or definition", () => {
  const schema = JSON.parse(readFileSync(NKG_SCHEMA_PATH, "utf8"));
  const hits: string[] = [];
  const names: string[] = [];
  const walk = (s: unknown, at: string) => {
    if (Array.isArray(s)) return s.forEach((x, i) => walk(x, `${at}/${i}`));
    if (!s || typeof s !== "object") return;
    const o = s as Record<string, unknown>;
    for (const key of ["properties", "definitions", "$defs", "patternProperties"]) {
      if (o[key] && typeof o[key] === "object") for (const k of Object.keys(o[key] as object)) names.push(`${at}/${key}/${k}`), FORBIDDEN.test(k) && hits.push(`${at}/${key}/${k}`);
    }
    if (Array.isArray(o.enum)) for (const v of o.enum) if (typeof v === "string") names.push(v), FORBIDDEN.test(v) && hits.push(`${at}/enum:${v}`);
    if (typeof o.const === "string") (names.push(o.const), FORBIDDEN.test(o.const) && hits.push(`${at}/const:${o.const}`));
    for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
  };
  walk(schema, "#");
  assert.ok(names.length > 100, "walker actually visited the schema");
  assert.ok(names.includes("Character") && names.some((n) => n.endsWith("/properties/meta")));
  assert.deepEqual(hits, []);
});

test("an NKG containing a Scene node or a dialogue field fails validation", () => {
  const a = fixtureNkg() as unknown as { nodes: unknown[] };
  a.nodes.push({ id: "sc01", type: "Scene", module: "M03", label: "x", based_on: [], meta: fixtureMeta(["s000000001"]) });
  assert.equal(validateNkg(a).ok, false);

  const b = fixtureNkg() as unknown as { nodes: Record<string, unknown>[] };
  b.nodes[0].dialogue = "……";
  const vb = validateNkg(b);
  assert.equal(vb.ok, false);
  assert.ok(vb.errors.some((e) => /additional/.test(e)), vb.errors.join(" | "));

  const c = fixtureNkg() as unknown as { edges: Record<string, unknown>[] };
  c.edges[0].quote = "x";
  assert.equal(validateNkg(c).ok, false);
});

// ---------- soft limits ----------
test("70 Events and long labels → ok:true with warnings (soft limits never block)", () => {
  const n = fixtureNkg();
  for (let i = 3; i <= 72; i++) {
    n.nodes.push({
      id: `ev${String(i).padStart(2, "0")}`,
      type: "Event",
      module: "M03",
      label: "とても長いラベル".repeat(8),
      summary: "あ".repeat(200),
      story_order: i,
      disclosure_phase: null,
      based_on: [],
      meta: fixtureMeta(["s000000001"]),
    });
  }
  const v = validateNkg(n);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /Event count 72 > 60 total/.test(w)), v.warnings.slice(0, 5).join(" | "));
  assert.ok(v.warnings.some((w) => /per coverage unit/.test(w)));
  assert.ok(v.warnings.some((w) => /label \d+ chars > 40/.test(w)));
  assert.ok(v.warnings.some((w) => /summary 200 chars > 160/.test(w)));
});

test("writeValidation writes nkg/validation.json", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nkgv-"));
  try {
    const { validation, output } = writeValidation(dir, fixtureNkg(), new Date("2026-11-23T00:00:00Z"));
    assert.equal(output, "nkg/validation.json");
    const disk = JSON.parse(readFileSync(path.join(dir, "nkg", "validation.json"), "utf8"));
    assert.equal(disk.ok, true);
    assert.deepEqual(disk.elements, validation.elements);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture sources carry no excerpt text", () => {
  for (const s of FIXTURE_SOURCES) assert.ok(!("excerpts" in s));
});
