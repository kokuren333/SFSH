import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { countClaimsByModule, expandProfiles, loadGenreProfiles, loadGenreVocabulary, normalizeGenre, selectModules, type ModuleSelectionFile } from "../src/nkg/modules.ts";
import { GENRE_SCHEMA, MODULE_REVIEW_SCHEMA } from "../src/nkg/prompts/modules.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";
import { cannedS2, fixtureClaims, fixtureContext, makeFixtureWork } from "../src/nkg/testWork.ts";
import { strictSchemaViolations } from "../src/model/validate.ts";

test("genre vocabulary and profiles are consistent", () => {
  const vocab = loadGenreVocabulary();
  const prof = loadGenreProfiles();
  const labels = vocab.genres.map((g) => g.label);
  for (const l of ["推理", "サスペンス", "政治劇", "恋愛", "人間ドラマ", "バトル", "ファンタジー", "SF", "ダークファンタジー", "叙述トリック", "群像劇", "歴史", "青春", "ホラー", "コメディ", "日常"]) assert.ok(labels.includes(l), l);
  assert.deepEqual(prof.always_on, ["M01", "M02", "M03", "M06", "M07", "M10", "M12"]);
  for (const g of vocab.genres) {
    const p = prof.profiles[g.slug];
    assert.ok(p, `profile for ${g.slug}`);
    for (const m of p.add) assert.ok(prof.selectable.includes(m), `${g.slug} adds selectable only (${m})`);
  }
  // §2.5 initial values
  assert.deepEqual([...prof.profiles.mystery.add].sort(), ["M04", "M05", "M09"]);
  assert.ok(prof.profiles.romance.add.includes("M11") && prof.profiles.romance.weights.M06 > 0 && prof.profiles.romance.weights.M01 > 0);
  assert.ok(prof.profiles.fantasy.add.includes("M08"));
  assert.ok(prof.profiles.narrative_trick.add.includes("M04") && prof.profiles.narrative_trick.add.includes("M05"));
});

test("normalizeGenre accepts slug or label, rejects everything else", () => {
  const v = loadGenreVocabulary();
  assert.equal(normalizeGenre("Mystery", v), "mystery");
  assert.equal(normalizeGenre("人間ドラマ", v), "human_drama");
  assert.equal(normalizeGenre("ＳＦ", v), "sf");
  assert.equal(normalizeGenre("推理小説", v), null);
});

test("expandProfiles is deterministic (max delta per module)", () => {
  const p = loadGenreProfiles();
  const e = expandProfiles(["romance", "human_drama"], p);
  assert.deepEqual(e.enabled, ["M01", "M02", "M03", "M06", "M07", "M10", "M11", "M12"]);
  assert.equal(e.weights.M06, 1.3);
  assert.equal(e.weights.M07, 1.2);
  assert.deepEqual(e.origin.M11, ["genre:romance", "genre:human_drama"]);
  assert.deepEqual(expandProfiles(["romance", "human_drama"], p), e);
});

test("module prompt schemas are OpenAI-strict", () => {
  assert.deepEqual(strictSchemaViolations(GENRE_SCHEMA), []);
  assert.deepEqual(strictSchemaViolations(MODULE_REVIEW_SCHEMA), []);
});

test("selectModules: vocabulary filter, Haiku add/remove rules, sufficiency → gaps", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nkgm-"));
  try {
    makeFixtureWork(dir);
    const calls: FakeCall[] = [];
    const ctx = fixtureContext(dir, fakePort("luna", cannedS2, calls), fakePort("haiku", cannedS2, calls));
    const res = await selectModules(ctx);
    assert.deepEqual(res.outputs, ["nkg/module_selection.json"]);
    assert.deepEqual(calls.map((c) => `${c.port}:${c.req.task}`), ["luna:s2.genre", "haiku:s2.modules.review"]);

    const f = JSON.parse(readFileSync(path.join(dir, "nkg", "module_selection.json"), "utf8")) as ModuleSelectionFile;
    assert.deepEqual(f.genres.accepted.map((g) => g.slug), ["mystery", "human_drama"]);
    assert.deepEqual(f.genres.dropped, [{ genre: "推理小説", reason: "not_in_vocabulary" }]);
    assert.deepEqual(f.expansion.enabled, ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M09", "M10", "M11", "M12"]);

    assert.deepEqual(f.haiku.applied.map((a) => `${a.action}:${a.module}`), ["add:M08", "remove:M11"]);
    assert.deepEqual(
      f.haiku.rejected.map((r) => `${r.action}:${r.module}:${r.why}`),
      ["add:M02:already_enabled", "add:M99:invalid_module_id", "remove:M99:invalid_module_id"],
    );

    const sel = Object.fromEntries(f.module_selection.map((m) => [m.module, m]));
    assert.equal(f.module_selection.length, 12);
    // M07 is always-on but has only 2 claims; M08 added by Haiku but 2 claims; M09 has none with a card
    for (const m of ["M07", "M08", "M09"]) {
      assert.equal(sel[m].enabled, false, m);
      assert.equal(sel[m].reason, "insufficient_sources", m);
      assert.equal(sel[m].weight, 0);
    }
    assert.equal(sel.M11.enabled, false);
    assert.match(sel.M11.reason, /^haiku_removed/);
    for (const m of ["M01", "M02", "M03", "M04", "M05", "M06", "M10", "M12"]) assert.equal(sel[m].enabled, true, m);
    assert.equal(sel.M06.weight, 1.3);
    assert.deepEqual(f.insufficient.map((i) => i.module), ["M07", "M08", "M09"]);
    assert.deepEqual(f.gaps.map((g) => [g.module, g.reason]), [["M07", "insufficient_sources"], ["M08", "insufficient_sources"], ["M09", "insufficient_sources"]]);
    assert.equal(res.metrics.modules_insufficient, 3);

    // idempotent: rerun overwrites with the same content
    await selectModules(ctx);
    const again = JSON.parse(readFileSync(path.join(dir, "nkg", "module_selection.json"), "utf8"));
    assert.deepEqual(again, f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("countClaimsByModule ignores non-module aspects", () => {
  const c = countClaimsByModule(fixtureClaims());
  assert.equal(c.M01, 4, "raw count (status filtering happens in selectModules)");
  assert.equal(c.M07, 2);
  assert.ok(!("genre" in c));
});
