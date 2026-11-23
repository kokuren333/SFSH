/** AMENDMENT 11: long spoiler synopsis (S3 write, new page type) — flow, C-2 / C-7 rules, compose, write parts. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkPublicWork, forbiddenContent } from "../src/gen/check.ts";
import { composePublic } from "../src/gen/compose.ts";
import { projectPublic } from "../src/gen/project.ts";
import { COPIED_SENTENCE, EXCERPT_TEXT, HIDDEN_LABEL, INTERNAL_ANALYSIS, PUBLIC_ANALYSIS, genContext, makeGenWork } from "../src/gen/testFixtures.ts";
import { POLITE_MIN, politeRatio, synopsisTarget, writeSynopsis } from "../src/gen/synopsis.ts";
import { offlineStage } from "../src/job/runner.ts";
import { parseWriteParts } from "../src/job/regen.ts";
import type { ModelRequest } from "../src/model/types.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";
import type { PublicWork } from "../../site/src/public-types.ts";

const read = (dir: string, rel: string) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
const sec = (o: Record<string, unknown>) => ({ heading: null, spoiler: "none", epistemic: "canon", ...o });

function ports(calls: FakeCall[]) {
  let lunaRound = 0;
  const haiku = fakePort(
    "haiku",
    (req: ModelRequest) => {
      if (req.task === "s3.synopsis.plan")
        return {
          intro: { paragraphs: ["人物甲が組織の中で居場所を守ろうとし、やがて離れるまでの物語です。"], based_on: ["ch01", "oc01"] },
          chapters: [
            { heading: "裏切りの発覚", phase_ids: ["ph1"], event_ids: ["ev01"], claim_ids: ["c0001"], introduces: ["人物甲", "人物乙"], gist: "発覚と動揺", target_chars: 900 },
            { heading: "決別", phase_ids: ["ph3"], event_ids: ["ev02", "ev03"], claim_ids: [], introduces: [], gist: "対立から和解、離脱", target_chars: 5000 },
          ],
        };
      if (req.task === "s3.synopsis.chapter") {
        if (req.prompt.includes("第1章「裏切りの発覚」"))
          return {
            sections: [
              sec({ heading: "発覚", paragraphs: [`人物甲は相棒の人物乙とともに組織にいます。${COPIED_SENTENCE}`], based_on: ["ch01", "ch02", "ev01", "zz99", "th01"] }),
              sec({ heading: "テーマだけ", paragraphs: ["信頼の主題が見えてきます。"], based_on: ["th01"] }),
            ],
          };
        return { sections: [sec({ heading: "対立と和解", paragraphs: ["対立が激しくなり、やがて和解します。"], based_on: ["ev02", "ev03"], spoiler: "ending" }), sec({ heading: "離脱", paragraphs: ["甲は組織を離れます。"], based_on: ["oc01"] })] };
      }
      if (req.task === "s3.synopsis.revise") return { responses: [], updated: [], removed_ids: [] };
      if (req.task === "s3.synopsis.rewrite") return { units: [{ id: "syn_c01_s01", paragraphs: [`人物甲は相棒の人物乙とともに組織にいます。${COPIED_SENTENCE}`], question: null, answer: null, explanation: null }] };
      return undefined;
    },
    calls,
  );
  const luna = fakePort(
    "luna",
    (req: ModelRequest) => {
      if (req.task !== "s3.synopsis.review") return undefined;
      lunaRound++;
      return { findings: [{ target_id: "syn_c02_s02", type: "copied_phrase", severity: "high", evidence: lunaRound === 1 ? "言い回しが近い" : "まだ近い" }] };
    },
    calls,
  );
  return { haiku, luna };
}

test("writeSynopsis: plan → parallel chapters → review → copied_phrase deletion, 30-char guard, fact-layer based_on, compose", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-syn-"));
  try {
    const dir = makeGenWork(root);
    const calls: FakeCall[] = [];
    const { haiku, luna } = ports(calls);
    const ctx = genContext(dir, luna, haiku);
    await projectPublic(ctx);
    const res = await writeSynopsis(ctx);

    assert.deepEqual(
      calls.map((c) => `${c.port}:${c.req.task}`),
      ["haiku:s3.synopsis.plan", "haiku:s3.synopsis.chapter", "haiku:s3.synopsis.chapter", "luna:s3.synopsis.review", "haiku:s3.synopsis.revise", "luna:s3.synopsis.review", "haiku:s3.synopsis.revise", "haiku:s3.synopsis.rewrite"],
    );
    const plan = calls[0]!.req.prompt;
    for (const s of [HIDDEN_LABEL, INTERNAL_ANALYSIS, EXCERPT_TEXT, PUBLIC_ANALYSIS, "崩壊の読み解き。"]) assert.equal(plan.includes(s), false, `synopsis material leaked ${s} (non-public or interpretation layer)`);
    assert.ok(plan.includes("主張 c0001"), "canon story claims are part of the material");
    assert.match(plan, /台詞/);
    assert.match(plan, /解釈・考察・評価・テーマ論を混ぜない/);
    assert.ok(calls[1]!.req.prompt.includes("すでに前の章で紹介済みの人物: なし"));
    assert.ok(calls[2]!.req.prompt.includes("すでに前の章で紹介済みの人物: 人物甲、人物乙"));

    const page = read(dir, "gen/pages/synopsis.json");
    assert.deepEqual(page.blocks.map((b: { id: string }) => b.id), ["syn_intro", "syn_c01_s01", "syn_c02_s01"], "c01_s02 (theme only) dropped; c02_s02 deleted (copied_phrase unresolved)");
    assert.deepEqual(page.intro_ids, ["syn_intro"]);
    assert.deepEqual(page.chapters, [
      { id: "syn_c01", heading: "裏切りの発覚", block_ids: ["syn_c01_s01"] },
      { id: "syn_c02", heading: "決別", block_ids: ["syn_c02_s01"] },
    ]);
    const c01 = page.blocks[1];
    assert.deepEqual(c01.based_on, ["ch01", "ch02", "ev01"], "unknown and essay-layer ids removed");
    assert.equal(c01.paragraphs.join("").includes(COPIED_SENTENCE), false, "30-char guard dropped the sentence after one rewrite");
    assert.equal(c01.spoiler, "mid", "max(declared none, ev01 mid)");
    for (const b of page.blocks) assert.ok(b.authored_by === "haiku" && b.reviewed_by === "luna");
    const rep = read(dir, "gen/synopsis_report.json");
    assert.deepEqual(rep.deleted_copied_phrase, ["syn_c02_s02"]);
    assert.deepEqual(rep.dropped_no_basis, ["syn_c01_s02"]);
    assert.equal(rep.below_target, true);
    assert.equal(rep.chapters.length, 2);
    assert.ok(read(dir, "gen/reviews/synopsis.json").counts.findings >= 2);
    assert.equal(res.metrics.synopsis_chapters, 2);

    // compose: optional pages.synopsis, shape-checked, nothing internal leaks
    await composePublic(ctx);
    const pw = read(dir, "gen/public.json") as PublicWork;
    assert.deepEqual(checkPublicWork(pw), []);
    assert.deepEqual(forbiddenContent(pw), []);
    assert.equal(pw.pages.synopsis!.chapters.length, 2);
    assert.equal(pw.pages.synopsis!.intro[0]!.id, "syn_intro");
    assert.equal(JSON.stringify(pw.pages.synopsis).includes("authored_by"), false);
    assert.equal(pw.work.spoiler_max, "ending");
    assert.equal(read(dir, "gen/gen_check.json").blocks.synopsis_chapters, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write stage parts: --parts synopsis runs only the synopsis; shape check accepts files without synopsis", async () => {
  assert.deepEqual(parseWriteParts(["synopsis"]), ["synopsis"]);
  assert.equal(parseWriteParts(undefined), undefined);
  assert.throws(() => parseWriteParts(["bogus"]), /unknown part/);
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-syn2-"));
  try {
    const dir = makeGenWork(root);
    const calls: FakeCall[] = [];
    const { haiku, luna } = ports(calls);
    const ctx = { ...genContext(dir, luna, haiku), writeParts: ["synopsis"] as const };
    await projectPublic(ctx);
    await offlineStage("write")(ctx);
    assert.equal(calls.some((c) => c.req.task === "s3.write"), false, "page text not re-written");
    assert.ok(calls.some((c) => c.req.task === "s3.synopsis.plan"));
    await composePublic(ctx);
    const pw = read(dir, "gen/public.json") as PublicWork;
    const { synopsis: _s, ...pagesWithout } = pw.pages;
    assert.deepEqual(checkPublicWork({ ...pw, pages: pagesWithout }), [], "public.json composed before A11 (no synopsis) stays valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synopsisTarget scales with the work", () => {
  const w = (medium: string, coverage_label: string) => ({ work: { medium, coverage_label } }) as unknown as PublicWork;
  assert.deepEqual(synopsisTarget(w("film", "全体")), [8000, 10000]);
  assert.deepEqual(synopsisTarget(w("anime", "全12話")), [9000, 12000]);
  assert.deepEqual(synopsisTarget(w("anime", "全50話")), [12000, 15000]);
  assert.deepEqual(synopsisTarget(w("novel", "全体")), [9000, 12000]);
});

test("politeRatio: share of です・ます sentence ends (style pass trigger)", () => {
  assert.equal(politeRatio(["彼は組織を離れた。彼女は残ります。"]), 0.5);
  assert.equal(politeRatio(["発覚しました。「掟」です。"]), 1);
  assert.ok(politeRatio(["彼は行った。彼女は来た。"]) < POLITE_MIN);
});
