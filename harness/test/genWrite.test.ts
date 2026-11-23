import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strictSchemaViolations } from "../src/model/validate.ts";
import type { ModelRequest } from "../src/model/types.ts";
import { projectPublic } from "../src/gen/project.ts";
import { TAGS_SCHEMA, TAG_REVISION_SCHEMA } from "../src/gen/prompts.ts";
import { COPIED_SENTENCE, EXCERPT_TEXT, HIDDEN_LABEL, INTERNAL_ANALYSIS, genContext, makeGenWork } from "../src/gen/testFixtures.ts";
import { splitSentences, writePages } from "../src/gen/write.ts";
import { FINDINGS_SCHEMA } from "../src/nkg/review.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";

const read = (dir: string, rel: string) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
const blk = (o: Record<string, unknown>) => ({ heading: null, spoiler: "none", epistemic: "sfsh_analysis", ...o });
const upd = (o: Record<string, unknown>) => ({ heading: null, paragraphs: [], question: null, answer: null, explanation: null, based_on: [], spoiler: "none", epistemic: "sfsh_analysis", ...o });

function writeOutput() {
  return {
    overview: [
      blk({ heading: "作品の骨格", paragraphs: ["甲と乙の信頼が軸になる。"], based_on: ["ch01", "ch04", "zz99", "oc01"], epistemic: "canon" }),
      blk({ heading: "人物", paragraphs: ["甲と乙の関係が物語を動かす。"], based_on: ["ch01", "ch02"], epistemic: "canon" }),
      blk({ heading: "根拠なし", paragraphs: ["記憶だけに頼った話。"], based_on: ["ch04"] }),
    ],
    figure_notes: [
      blk({ figure: "relations", paragraphs: [`関係の変化に注目する。${COPIED_SENTENCE}`], based_on: ["rl01"] }),
      blk({ figure: "reverse_plot", paragraphs: ["結末から原因へ読む。"], based_on: ["oc01"] }),
      blk({ figure: "matrix", paragraphs: ["読者の列に注目する。"], based_on: ["se01"] }),
    ],
    intros: [
      blk({ page: "themes", paragraphs: [COPIED_SENTENCE], based_on: ["th01"] }),
      blk({ page: "context", paragraphs: ["受容の広がりを見る。"], based_on: ["cx01"] }),
      blk({ page: "interpretations", paragraphs: ["読みが分かれる点を並べる。"], based_on: ["ip01"] }),
    ],
    quiz: [
      { quiz_id: "qz01", question: "甲が組織を離れたのはなぜか", answer: "信頼が崩れたから", explanation: "直接の原因が信頼の崩壊にあるため。", based_on: ["ev01", "ch04"], spoiler: "none" },
      { quiz_id: "qz99", question: "存在しない問い", answer: "なし", explanation: "なし", based_on: ["wy01"], spoiler: "none" },
    ],
  };
}

test("S3 Luna-facing schemas are OpenAI-strict", () => {
  for (const s of [FINDINGS_SCHEMA, TAGS_SCHEMA, TAG_REVISION_SCHEMA]) assert.deepEqual(strictSchemaViolations(s), []);
});

test("splitSentences keeps text and punctuation", () => {
  assert.deepEqual(splitSentences("一文目。二文目！三文目"), ["一文目。", "二文目！", "三文目"]);
});

test("writePages: based_on filter, spoiler max, copied_phrase deletion, 30-char guard (rewrite once then drop), authorship", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genw-"));
  try {
    const dir = makeGenWork(root);
    const calls: FakeCall[] = [];
    let lunaRound = 0;
    let haikuRevise = 0;
    const haiku = fakePort(
      "haiku",
      (req: ModelRequest) => {
        if (req.task === "s3.write") return writeOutput();
        if (req.task === "s3.write.revise") {
          haikuRevise++;
          if (haikuRevise === 1)
            return {
              responses: [
                { finding_id: "r1f01", action: "declined", reason: "自分の言葉で書いている" },
                { finding_id: "r1f02", action: "revised", reason: "根拠に沿って弱めた" },
              ],
              updated: [upd({ id: "ov01", heading: "作品の骨格", paragraphs: ["甲と乙の信頼が崩れていく構図が軸になる。"], based_on: ["ch01", "oc01", "ev02", "ch04"], epistemic: "canon" }), upd({ id: "new99", paragraphs: ["新規は無視される"] })],
              removed_ids: [],
            };
          return {
            responses: [
              { finding_id: "r2f01", action: "declined", reason: "直さない" },
              { finding_id: "r2f02", action: "declined", reason: "具体性は必要" },
            ],
            updated: [],
            removed_ids: [],
          };
        }
        if (req.task === "s3.write.rewrite")
          return {
            units: [
              { id: "fn_relations", paragraphs: [`関係の変化に注目する。${COPIED_SENTENCE}`], question: null, answer: null, explanation: null },
              { id: "themes_intro01", paragraphs: ["信頼の主題を扱う。"], question: null, answer: null, explanation: null },
            ],
          };
        return undefined;
      },
      calls,
    );
    const luna = fakePort(
      "luna",
      (req: ModelRequest) => {
        if (req.task !== "s3.write.review") return undefined;
        lunaRound++;
        if (lunaRound === 1)
          return {
            findings: [
              { target_id: "fn_reverse_plot", type: "copied_phrase", severity: "high", evidence: "言い回しが近い" },
              { target_id: "ov01", type: "unsupported", severity: "medium", evidence: "根拠が弱い" },
            ],
          };
        return {
          findings: [
            { target_id: "fn_reverse_plot", type: "copied_phrase", severity: "high", evidence: "まだ近い" },
            { target_id: "fn_matrix", type: "too_concrete", severity: "low", evidence: "場面に寄りすぎ" },
          ],
        };
      },
      calls,
    );
    const ctx = genContext(dir, luna, haiku);
    await projectPublic(ctx);
    const res = await writePages(ctx);

    // calls: tasks, jobId, input isolation
    assert.deepEqual(
      calls.map((c) => `${c.port}:${c.req.task}`),
      ["haiku:s3.write", "luna:s3.write.review", "haiku:s3.write.revise", "luna:s3.write.review", "haiku:s3.write.revise", "haiku:s3.write.rewrite"],
    );
    for (const c of calls) assert.equal(c.req.jobId, "job-gen-test");
    const writeReq = calls[0].req.prompt;
    for (const s of [HIDDEN_LABEL, INTERNAL_ANALYSIS, EXCERPT_TEXT, "非公開の秘密", "未確認の出来事", "非公開人物の動機"]) assert.equal(writeReq.includes(s), false, `write prompt leaked ${s}`);
    for (const s of ["居場所を守りたい", "掟", "不安の高まり", "崩壊の読み解き。"]) assert.ok(writeReq.includes(s), `CP-026 public element missing from write input: ${s}`);
    assert.match(writeReq, /台詞/);
    assert.match(writeReq, /自分の言葉/);
    assert.ok(calls[1].req.prompt.includes("主張 c0001"), "Luna sees the claims behind the elements");

    const overview = read(dir, "gen/pages/overview.json").blocks;
    assert.deepEqual(overview.map((b: { id: string }) => b.id), ["ov01", "ov02"], "ov03 (no public basis) dropped");
    const ov01 = overview[0];
    assert.deepEqual(ov01.based_on, ["ch01", "oc01", "ev02"], "non-public / unknown ids removed; CP-026 elements (events) are citable");
    assert.equal(ov01.spoiler, "ending", "max(declared none, oc01 ending)");
    assert.equal(ov01.epistemic, "sfsh_analysis", "declared canon but oc01 is sfsh_analysis");
    assert.equal(ov01.review, "revised");
    assert.deepEqual(ov01.paragraphs, ["甲と乙の信頼が崩れていく構図が軸になる。"]);
    assert.equal(overview[1].epistemic, "canon");
    assert.equal(overview[1].review, "agreed");

    const notes = read(dir, "gen/pages/figure_notes.json").blocks;
    assert.deepEqual(notes.map((b: { id: string }) => b.id), ["fn_relations", "fn_matrix"], "unresolved copied_phrase → fn_reverse_plot deleted");
    assert.deepEqual(notes[0].paragraphs, ["関係の変化に注目する。"], "still-matching sentence dropped after one rewrite");
    assert.equal(notes[1].review, "disputed");
    assert.deepEqual(read(dir, "gen/pages/themes.json").blocks[0].paragraphs, ["信頼の主題を扱う。"], "rewrite fixed the block");

    const quiz = read(dir, "gen/pages/quiz.json").items;
    assert.equal(quiz.length, 1);
    assert.deepEqual(quiz[0].based_on, ["ev01"]);
    assert.equal(quiz[0].spoiler, "mid", "max(declared none, ev01 mid)");
    assert.equal(quiz[0].quiz_type, "causal");

    for (const p of ["overview", "figure_notes", "themes", "context", "interpretations", "quiz"]) {
      const f = read(dir, `gen/pages/${p}.json`);
      for (const u of [...f.blocks, ...(f.items ?? [])]) {
        assert.equal(u.authored_by, "haiku");
        assert.equal(u.reviewed_by, "luna");
        assert.ok(["agreed", "revised", "disputed"].includes(u.review));
      }
    }

    const rev = read(dir, "gen/reviews/pages.json");
    assert.equal(rev.rounds.length, 2);
    assert.deepEqual(rev.deleted, [{ id: "fn_reverse_plot", reason: "copied_phrase" }]);
    assert.ok(rev.advisory.some((a: { target_id: string; type: string }) => a.target_id === "fn_matrix" && a.type === "too_concrete"));
    assert.ok(rev.unresolved.some((u: { target_id: string }) => u.target_id === "fn_reverse_plot"));

    const rep = read(dir, "gen/write_report.json");
    assert.deepEqual(rep.dropped_no_basis, ["ov03"]);
    const g = Object.fromEntries(rep.guard.records.map((r: { id: string }) => [r.id, r]));
    assert.equal(g.fn_relations.rewritten, true);
    assert.equal(g.fn_relations.still_flagged_after_rewrite, 1);
    assert.equal(g.fn_relations.dropped_sentences.length, 1);
    assert.equal(g.themes_intro01.still_flagged_after_rewrite, 0);
    assert.equal(readFileSync(path.join(dir, "gen/write_report.json"), "utf8").includes(COPIED_SENTENCE), false, "report stores no copied text");

    assert.equal(res.metrics.deleted_copied_phrase, 1);
    assert.equal(res.metrics.guard_rewritten_units, 2);
    assert.equal(res.metrics.guard_dropped_sentences, 1);
    assert.equal(res.metrics.dropped_no_basis, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writePages: failed rewrite → flagged sentences dropped; fully copied block / quiz field dropped; quiz falls back to node text", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-genw2-"));
  try {
    const dir = makeGenWork(root);
    const calls: FakeCall[] = [];
    const haiku = fakePort(
      "haiku",
      (req: ModelRequest) => {
        if (req.task === "s3.write")
          return {
            overview: [blk({ paragraphs: ["前提を述べる。"], based_on: ["ch01"] }), blk({ paragraphs: [COPIED_SENTENCE], based_on: ["ch02"] })],
            figure_notes: [],
            intros: [],
            quiz: [{ quiz_id: "qz01", question: "", answer: "", explanation: `短い説明。${COPIED_SENTENCE}`, based_on: ["ev01"], spoiler: "none" }],
          };
        if (req.task === "s3.write.rewrite") throw new Error("model down");
        return undefined;
      },
      calls,
    );
    const luna = fakePort("luna", (req) => (req.task === "s3.write.review" ? { findings: [] } : undefined), calls);
    const ctx = genContext(dir, luna, haiku);
    await projectPublic(ctx);
    const res = await writePages(ctx);
    assert.deepEqual(read(dir, "gen/pages/overview.json").blocks.map((b: { id: string }) => b.id), ["ov01"]);
    const quiz = read(dir, "gen/pages/quiz.json").items;
    assert.equal(quiz[0].question, "甲はなぜ組織を離れたのか", "empty fields from Haiku fall back to the reviewed node text");
    assert.equal(quiz[0].explanation, "短い説明。", "copied sentence dropped from the quiz field");
    assert.equal(quiz[0].authored_by, "haiku");
    assert.equal(res.metrics.guard_dropped_units, 1);
    assert.ok(res.warnings.some((w) => w.includes("rewrite call failed")));
    assert.equal(calls.filter((c) => c.req.task === "s3.write.rewrite").length, 1, "exactly one rewrite attempt");
    assert.equal(calls.filter((c) => c.req.task === "s3.write.review").length, 1, "no findings → one review round");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
