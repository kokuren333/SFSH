import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkPublicWork, forbiddenContent } from "../src/gen/check.ts";
import { composePublic } from "../src/gen/compose.ts";
import { projectPublic } from "../src/gen/project.ts";
import { GEN_WORK_ID, genContext, genNkg, makeGenWork } from "../src/gen/testFixtures.ts";
import { writePages } from "../src/gen/write.ts";
import type { ModelRequest } from "../src/model/types.ts";
import { fakePort } from "../src/nkg/testFixtures.ts";

const read = (dir: string, rel: string) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
const blk = (o: Record<string, unknown>) => ({ heading: null, spoiler: "none", epistemic: "sfsh_analysis", ...o });

const haiku = fakePort("haiku", (req: ModelRequest) =>
  req.task === "s3.write"
    ? {
        overview: [blk({ heading: "骨格", paragraphs: ["甲と乙の信頼が軸になる。"], based_on: ["ch01", "ch02"], epistemic: "canon" }), blk({ paragraphs: ["結末へ向かう因果を見る。"], based_on: ["oc01"] })],
        figure_notes: [blk({ figure: "relations", paragraphs: ["相棒関係の変化に注目する。"], based_on: ["rl01"] }), blk({ figure: "matrix", paragraphs: ["読者の列を見る。"], based_on: ["se01"] })],
        intros: [blk({ page: "themes", paragraphs: ["信頼の主題。"], based_on: ["th01"] })],
        quiz: [{ quiz_id: "qz01", question: "甲が離れたのはなぜか", answer: "信頼が崩れたから", explanation: "崩壊が直接の原因だから。", based_on: ["wy01"], spoiler: "mid" }],
      }
    : undefined,
);
const luna = fakePort("luna", (req: ModelRequest) => (req.task === "s3.write.review" ? { findings: [] } : undefined));

test("composePublic: valid PublicWork, no internal fields, work.json / INDEX.json updated, gen_check", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genc-"));
  try {
    const dir = makeGenWork(root);
    const ctx = genContext(dir, luna, haiku, "2026-11-23T01:00:00Z");
    // tags written by suggestTags earlier (one off-vocab entry is filtered again here)
    mkdirSync(path.join(dir, "gen"), { recursive: true });
    writeFileSync(path.join(dir, "gen", "tags.json"), JSON.stringify({ authored_by: "luna", reviewed_by: "haiku", final: ["school", "bogus_tag", "family"] }));
    await projectPublic(ctx);
    await writePages(ctx);
    const res = await composePublic(ctx);

    const pubText = readFileSync(path.join(dir, "gen", "public.json"), "utf8");
    const pw = JSON.parse(pubText);
    assert.deepEqual(checkPublicWork(pw), []);
    assert.deepEqual(forbiddenContent(pw), []);
    for (const s of ["authored_by", "reviewed_by", '"review"', "findings", "slot", "provenance", "excerpts", "research/raw"]) assert.equal(pubText.includes(s), false, `public.json contains ${s}`);
    assert.equal(pw.pages.overview.length, 2);
    assert.equal(pw.pages.figure_notes.relations.paragraphs[0], "相棒関係の変化に注目する。");
    assert.equal(pw.pages.figure_notes.reverse_plot, null);
    assert.equal(pw.pages.themes.intro.length, 1);
    assert.equal(pw.pages.quiz[0].question, "甲が離れたのはなぜか");
    assert.deepEqual(pw.work.tags, ["school", "family"]);
    assert.equal(pw.work.first_published_at, "2026-11-23T01:00:00.000Z");
    assert.equal(pw.work.updated_at, "2026-11-23T01:00:00.000Z");

    const work = read(dir, "work.json");
    assert.deepEqual(work.tags, ["school", "family"]);
    assert.deepEqual(work.genres, ["mystery"]);
    assert.equal(work.status, "completed");
    assert.equal(work.coverage_label, "全体");
    assert.equal(work.spoiler_max, "ending");
    assert.equal(work.has_matrix, true);
    assert.equal(work.first_published_at, "2026-11-23T01:00:00.000Z");
    assert.equal(work.history.length, 1, "history untouched");
    const index = read(root, "INDEX.json");
    const entry = index.works.find((e: { work_id: string }) => e.work_id === GEN_WORK_ID);
    assert.deepEqual(entry.tags, ["school", "family"]);
    assert.equal(entry.updated_at, "2026-11-23T01:00:00.000Z");

    const chk = read(dir, "gen/gen_check.json");
    assert.equal(chk.authorship.violations_total, 0);
    assert.equal(chk.authorship.nkg_elements_checked, genNkg().nodes.length + genNkg().edges.length);
    assert.equal(chk.authorship.page_units_checked, 6);
    assert.equal(chk.authorship.tags_checked, 1);
    assert.equal(chk.authorship.tags_violations, 0);
    assert.equal(chk.authorship.tags_authored_by, "luna");
    assert.equal(chk.authorship.tags_reviewed_by, "haiku");
    assert.equal(chk.public_json_bytes, Buffer.byteLength(pubText, "utf8"));
    assert.equal(res.metrics.authorship_violations, 0);

    // second compose later: first_published_at kept, updated_at moves
    await composePublic(genContext(dir, luna, haiku, "2026-11-24T05:00:00Z"));
    const w2 = read(dir, "work.json");
    assert.equal(w2.first_published_at, "2026-11-23T01:00:00.000Z");
    assert.equal(w2.updated_at, "2026-11-24T05:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePublic: authorship violation in a page block is counted; malformed page data is rejected", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genc2-"));
  try {
    const dir = makeGenWork(root);
    const ctx = genContext(dir, luna, haiku);
    await projectPublic(ctx);
    await writePages(ctx);
    const ov = read(dir, "gen/pages/overview.json");
    ov.blocks[0].reviewed_by = "haiku";
    writeFileSync(path.join(dir, "gen/pages/overview.json"), JSON.stringify(ov));
    const res = await composePublic(ctx);
    assert.equal(res.metrics.authorship_violations, 1);
    assert.equal(read(dir, "gen/gen_check.json").authorship.violation_ids[0], "page:overview:ov01");

    ov.blocks[0].spoiler = "huge";
    writeFileSync(path.join(dir, "gen/pages/overview.json"), JSON.stringify(ov));
    await assert.rejects(composePublic(ctx), /public\.json rejected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePublic: gen/tags.json authorship is checked (missing fields / author = reviewer → violation; absent file → not checked)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genc4-"));
  try {
    const dir = makeGenWork(root);
    const ctx = genContext(dir, luna, haiku);
    await projectPublic(ctx);
    await writePages(ctx);
    // no tags.json → nothing checked for tags
    await composePublic(ctx);
    let a = read(dir, "gen/gen_check.json").authorship;
    assert.equal(a.tags_checked, 0);
    assert.equal(a.tags_violations, 0);
    assert.equal(a.violations_total, 0);
    // tags.json without authorship fields (pre-M3 shape) → violation
    writeFileSync(path.join(dir, "gen", "tags.json"), JSON.stringify({ final: ["school"] }));
    let res = await composePublic(ctx);
    a = read(dir, "gen/gen_check.json").authorship;
    assert.equal(a.tags_checked, 1);
    assert.equal(a.tags_violations, 1);
    assert.deepEqual(a.violation_ids, ["tags:gen/tags.json"]);
    assert.equal(res.metrics.authorship_violations, 1);
    assert.ok(res.warnings.some((w) => w.includes("tags:gen/tags.json")));
    // author = reviewer → violation
    writeFileSync(path.join(dir, "gen", "tags.json"), JSON.stringify({ authored_by: "luna", reviewed_by: "luna", final: ["school"] }));
    res = await composePublic(ctx);
    a = read(dir, "gen/gen_check.json").authorship;
    assert.equal(a.tags_violations, 1);
    assert.equal(a.tags_authored_by, "luna");
    assert.equal(a.tags_reviewed_by, "luna");
    // proper header → ok
    writeFileSync(path.join(dir, "gen", "tags.json"), JSON.stringify({ authored_by: "luna", reviewed_by: "haiku", final: ["school"] }));
    res = await composePublic(ctx);
    assert.equal(res.metrics.authorship_violations, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPublicWork: extra keys and wrong enums are reported", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genc3-"));
  try {
    const dir = makeGenWork(root);
    await projectPublic(genContext(dir, luna, haiku));
    const pw = read(dir, "gen/projection.json");
    // gen/projection.json = PublicWork + the internal chain_dropout summary (CP-029 ruling 2 note)
    assert.equal(typeof pw.chain_dropout.count, "number");
    delete pw.chain_dropout;
    assert.deepEqual(checkPublicWork(pw), []);
    pw.extra = 1;
    pw.viz.relations.characters[0].analysis = "x";
    pw.viz.relations.characters[0].grade = "Z";
    delete pw.sources[0].license;
    const errs = checkPublicWork(pw);
    assert.ok(errs.some((e) => e === "$.extra: extra key"));
    assert.ok(errs.some((e) => e.endsWith(".analysis: extra key")));
    assert.ok(errs.some((e) => e.includes(".grade: expected one of")));
    assert.ok(errs.some((e) => e.endsWith(".license: missing")));
    assert.ok(forbiddenContent({ a: { authored_by: "haiku" }, b: "see research/raw/s1.txt" }).length === 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
