/** AMENDMENT 12: deterministic coverage measures (claims and NKG fact layer) and their shortfall targets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Claim } from "../src/research/claimTypes.ts";
import { claimCoverage, factCoverage, mainCharacters, ranges, sameName, unitsTotal } from "../src/research/coverage.ts";
import { allowance } from "../src/research/frames.ts";

let n = 0;
function cl(p: Partial<Claim>): Claim {
  n++;
  return {
    claim_id: `c${String(n).padStart(4, "0")}`,
    text: p.text ?? "出来事",
    source_ids: ["s1"],
    evidence: [],
    aspects: p.aspects ?? ["plot"],
    epistemic: p.epistemic ?? "canon",
    phase_hint: p.phase_hint ?? "unknown",
    spoiler: p.spoiler ?? "none",
    entities: [],
    story_unit: p.story_unit ?? null,
    characters: p.characters ?? [],
    authored_by: "luna",
    reviewed_by: null,
    review: "pending",
    status: p.status ?? "active",
    drop_reason: null,
  };
}

test("coverage helpers: names, ranges, units", () => {
  assert.ok(sameName("鹿目まどか", "まどか"));
  assert.ok(!sameName("さやか", "まどか"));
  assert.deepEqual(ranges([12, 7, 8, 9, 3]), [[3, 3], [7, 9], [12, 12]]);
  assert.deepEqual(unitsTotal([cl({ aspects: ["bibliographic"], text: "テレビアニメ全12話として放送された" })]).total, 12);
  assert.equal(unitsTotal([cl({ story_unit: 1 }), cl({ story_unit: 2 }), cl({ story_unit: 9 })]).total, 9);
  assert.equal(unitsTotal([cl({ story_unit: 1 })]).total, null);
});

test("claimCoverage: buckets, missing units (later first), main characters, ending", () => {
  const claims: Claim[] = [cl({ aspects: ["bibliographic"], text: "全6話" })];
  for (let u = 1; u <= 3; u++) for (let k = 0; k < 3; k++) claims.push(cl({ story_unit: u, characters: ["鹿目まどか"], text: `第${u}話の出来事${k}` }));
  claims.push(cl({ aspects: ["M01"], characters: ["美樹さやか"] }), cl({ aspects: ["M01"], characters: ["さやか"] }), cl({ aspects: ["M01"], characters: ["美樹さやか"] }));
  claims.push(cl({ story_unit: 5, status: "dropped" }));
  const cov = claimCoverage(claims);
  assert.equal(cov.units.total, 6);
  assert.deepEqual(cov.units.missing, [4, 5, 6]);
  assert.equal(cov.buckets.early, 6); // units 1-2 of 6
  assert.equal(cov.buckets.middle, 3);
  assert.equal(cov.buckets.end, 0);
  const keys = cov.shortfalls.map((s) => s.key);
  assert.equal(keys[0], "ending");
  assert.ok(keys.includes("bucket:end") && keys.includes("bucket:middle") && !keys.includes("bucket:early"));
  assert.ok(keys.includes("units:4-6"));
  const mains = mainCharacters(claims);
  assert.equal(mains[0]!.name, "鹿目まどか");
  assert.ok(mains.some((m) => m.name === "美樹さやか" && m.mentions === 3));
  assert.ok(keys.includes(`character:美樹さやか`), keys.join(","));
  assert.ok(cov.shortfalls.every((s) => s.aspects.length > 0 && s.target.length > 0));
  assert.equal(cov.met, false);
});

test("factCoverage: events per phase, ending, characters in events", () => {
  const drafts = [
    { _type: "Character", id: "ch01", label: "石神哲哉" },
    { _type: "Character", id: "ch02", label: "湯川学" },
    { _type: "Event", id: "ev01", label: "石神が隣人を助ける", summary: "", phase_ref: "ph1" },
    { _type: "Event", id: "ev02", label: "湯川が再会する", summary: "石神と旧交を温める", phase_ref: "ph1" },
    { _type: "Event", id: "ev03", label: "捜査が進む", summary: "", phase_ref: "ph1" },
    { _type: "Event", id: "ev04", label: "自首", summary: "石神が出頭する", phase_ref: "ph2", spoiler: "ending" },
  ];
  const f = factCoverage(drafts, [{ id: "ph1", label: "発端" }, { id: "ph2", label: "結末" }]);
  assert.deepEqual(f.phases.map((p) => p.events), [3, 1]);
  const keys = f.shortfalls.map((s) => s.key);
  assert.deepEqual(keys.slice(0, 2), ["ending", "phase:ph2"]);
  assert.ok(!keys.includes("phase:ph1"));
  assert.ok(keys.includes("character:湯川学"));
  assert.ok(!keys.includes("character:石神哲哉"));
});

test("frame allowance never exceeds the job budget and keeps the reserve", () => {
  const b = { limits: { searches: 40, fetches: 60, wallMs: 1 }, searchesUsed: 30, fetchesUsed: 50, startedAt: "2026-01-01T00:00:00+09:00" };
  assert.deepEqual(allowance(b, { searches: 12, fetches: 22 }, { searches: 4, fetches: 5 }), { searches: 6, fetches: 5 });
  assert.deepEqual(allowance(b, { searches: 12, fetches: 22 }, { searches: 20, fetches: 20 }), { searches: 0, fetches: 0 });
});
