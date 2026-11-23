import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadTagVocab, readFinalTags } from "../src/gen/io.ts";
import { suggestTags } from "../src/gen/tags.ts";
import { genContext, makeGenWork } from "../src/gen/testFixtures.ts";
import type { ModelRequest } from "../src/model/types.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";

const t = (slug: string) => ({ slug, reason: "根拠あり", claim_refs: ["c0001", "c9999"] });

test("tags vocabulary: 40–60 attribute tags, ASCII snake_case slugs, unique, grouped", () => {
  const v = loadTagVocab();
  assert.ok(v.length >= 40 && v.length <= 60, `size ${v.length}`);
  assert.equal(new Set(v.map((x) => x.slug)).size, v.length);
  for (const x of v) {
    assert.match(x.slug, /^[a-z][a-z0-9_]*$/);
    assert.ok(["題材", "舞台", "形式", "受賞"].includes(x.group ?? ""), x.slug);
  }
});

test("suggestTags: off-vocab dropped, unresolved dropped, ≤ 8, Luna tools none / strict, Haiku reviews", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-gent-"));
  try {
    const dir = makeGenWork(root);
    const calls: FakeCall[] = [];
    let reviews = 0;
    const proposed = ["school", "not_a_tag", "family", "school", "revenge", "detective", "trick", "crime", "police", "courtroom", "friendship", "urban"].map(t);
    const luna = fakePort(
      "luna",
      (req: ModelRequest) => {
        if (req.task === "s3.tags") return { tags: proposed };
        if (req.task === "s3.tags.revise") {
          // keeps "revenge" (declines), swaps nothing else; adds an off-vocab one which code drops
          const fid = reviews === 1 ? "r1f01" : "r2f01";
          return { responses: [{ finding_id: fid, action: "declined", reason: "序盤で示される前提" }], tags: [...proposed.filter((x) => x.slug !== "not_a_tag"), t("ending_twist")] };
        }
        return undefined;
      },
      calls,
    );
    const haiku = fakePort(
      "haiku",
      (req: ModelRequest) => {
        if (req.task !== "s3.tags.review") return undefined;
        reviews++;
        return { findings: [{ target_id: "revenge", type: "spoiler", severity: "high", evidence: "結末に関わる動機を明かす" }] };
      },
      calls,
    );
    const ctx = genContext(dir, luna, haiku);
    const res = await suggestTags(ctx);
    assert.deepEqual(
      calls.map((c) => `${c.port}:${c.req.task}`),
      ["luna:s3.tags", "haiku:s3.tags.review", "luna:s3.tags.revise", "haiku:s3.tags.review", "luna:s3.tags.revise"],
    );
    for (const c of calls) assert.equal(c.req.jobId, "job-gen-test");
    assert.ok(calls[0].req.prompt.includes("school: 学校"), "vocabulary is listed in the prompt");
    assert.ok(calls[0].req.prompt.includes("主張 c0001"), "claims are the basis");

    const f = JSON.parse(readFileSync(path.join(dir, "gen", "tags.json"), "utf8"));
    const vocab = new Set(loadTagVocab().map((v) => v.slug));
    assert.ok(f.final.length <= 8);
    for (const s of f.final) assert.ok(vocab.has(s));
    assert.equal(f.final.includes("revenge"), false, "unresolved spoiler finding → dropped");
    assert.equal(f.final.includes("not_a_tag"), false);
    assert.deepEqual(f.final, ["school", "family", "detective", "trick", "crime", "police", "courtroom", "friendship"]);
    assert.ok(f.dropped.some((d: { slug: string; reason: string }) => d.slug === "not_a_tag" && d.reason === "not_in_vocab"));
    assert.ok(f.dropped.some((d: { slug: string; reason: string }) => d.slug === "ending_twist" && d.reason === "not_in_vocab"));
    assert.ok(f.dropped.some((d: { slug: string; reason: string }) => d.slug === "revenge" && d.reason === "unresolved"));
    assert.ok(f.dropped.some((d: { slug: string; reason: string }) => d.slug === "urban" && d.reason === "over_limit"));
    assert.deepEqual(f.proposals[0].claim_refs, ["c0001"], "unknown claim ids removed");
    assert.equal(f.authored_by, "luna", "proposer = the port that made s3.tags (§6.5)");
    assert.equal(f.reviewed_by, "haiku", "reviewer = the port that made s3.tags.review (§6.5)");
    assert.notEqual(f.authored_by, f.reviewed_by);
    assert.equal(res.metrics.final, 8);
    assert.deepEqual(readFinalTags(dir), f.final);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
