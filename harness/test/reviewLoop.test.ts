/** WP-2.1: full cross-review loop (REQUIREMENTS §3.3) — 2 rounds, C-2 deletion, advisory, zero-count warnings, metrics. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assembleNkg, buildFactLayer, buildPhases, deleteDrafts, structuralZeros } from "../src/nkg/build.ts";
import type { Draft } from "../src/nkg/elements.ts";
import { selectModules } from "../src/nkg/modules.ts";
import {
  REVIEW_MAX_ROUNDS,
  advisoryFrom,
  copiedPhraseTargets,
  lastRoundNote,
  priorRoundsBlock,
  runReviewLoop,
  type RawFinding,
  type ReviewRound,
  type ReviseInfo,
} from "../src/nkg/review.ts";
import { computeReviewSummary, summarizeReviews } from "../src/nkg/reviewSummary.ts";
import { fakePort, fillGroup, mEdge, mNode, type FakeCall } from "../src/nkg/testFixtures.ts";
import { cannedS2, fixtureContext, makeFixtureWork } from "../src/nkg/testWork.ts";
import type { Nkg } from "../src/nkg/types.ts";
import { validateNkg } from "../src/nkg/validate.ts";

const read = (dir: string, rel: string) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
const rf = (target_id: string, type: RawFinding["type"]): RawFinding => ({ target_id, type, severity: "medium", evidence: `ev-${target_id}-${type}` });

test("REVIEW_MAX_ROUNDS is 2 (§3.3-2)", () => {
  assert.equal(REVIEW_MAX_ROUNDS, 2);
});

test("runReviewLoop (2 rounds): last targeting round decides; not re-raised declined stays unresolved; unresolved/advisory/C-2 targets", async () => {
  const priors: number[] = [];
  const infos: ReviseInfo[] = [];
  const out = await runReviewLoop<string[]>({
    initial: ["a", "b", "c", "d", "e", "g"],
    maxRounds: REVIEW_MAX_ROUNDS,
    ids: (s) => s,
    review: async (_s, round, prior: ReviewRound[]) => {
      priors.push(prior.length);
      if (round === 1) return [rf("a", "overreach"), rf("b", "unsupported"), rf("c", "copied_phrase"), rf("d", "too_concrete"), rf("e", "copied_phrase")];
      // fresh review of the revised state: re-raises b, raises a new finding on f (added in round 1)
      assert.equal(prior[0].responses.length, 5);
      return [rf("b", "unsupported"), rf("f", "too_concrete")];
    },
    revise: async (s, findings, round, info) => {
      infos.push(info);
      const act = (id: string) => findings.find((f) => f.target_id === id)!.finding_id;
      if (round === 1)
        return {
          state: [...s, "f"],
          responses: [
            { finding_id: act("a"), action: "revised", reason: "ok" },
            { finding_id: act("b"), action: "declined", reason: "支持される" },
            { finding_id: act("c"), action: "declined", reason: "固有名だけ" },
            { finding_id: act("d"), action: "declined", reason: "抽象的" },
            { finding_id: act("e"), action: "revised", reason: "言い換えた" },
          ],
        };
      return {
        state: s,
        responses: [
          { finding_id: act("b"), action: "revised", reason: "弱めた" },
          { finding_id: act("f"), action: "declined", reason: "必要" },
        ],
      };
    },
  });
  assert.deepEqual(priors, [0, 1], "round 2 gets round 1 as prior");
  assert.deepEqual(infos, [
    { last: false, maxRounds: 2 },
    { last: true, maxRounds: 2 },
  ]);
  assert.equal(out.rounds.length, 2);
  assert.deepEqual(out.status, { a: "revised", b: "revised", c: "disputed", d: "disputed", e: "revised", f: "disputed", g: "agreed" });
  assert.deepEqual(out.counts, { findings: 7, revised: 3, declined: 4, unanswered: 0, rounds: 2 });
  assert.deepEqual(
    out.unresolved!.map((u) => `${u.target_id}:${u.types.join("+")}`).sort(),
    ["c:copied_phrase", "d:too_concrete", "f:too_concrete"],
  );
  const del = copiedPhraseTargets(out.unresolved);
  assert.deepEqual(del, ["c"]);
  assert.deepEqual(
    advisoryFrom(out.unresolved, del).map((a) => `${a.target_id}:${a.type}@${a.round}`).sort(),
    ["d:too_concrete@1", "f:too_concrete@2"],
  );
});

test("runReviewLoop: stops early when a review returns no findings; unanswered counts as declined", async () => {
  let revises = 0;
  const empty = await runReviewLoop<string[]>({
    initial: ["a"],
    maxRounds: 2,
    ids: (s) => s,
    review: async () => [],
    revise: async (s) => (revises++, { state: s, responses: [] }),
  });
  assert.equal(empty.rounds.length, 1);
  assert.equal(revises, 0);
  assert.deepEqual(empty.status, { a: "agreed" });
  assert.deepEqual(empty.unresolved, []);

  const una = await runReviewLoop<string[]>({
    initial: ["a"],
    maxRounds: 2,
    ids: (s) => s,
    review: async (_s, round) => (round === 1 ? [rf("a", "copied_phrase")] : []),
    revise: async (s) => ({ state: s, responses: [] }),
  });
  assert.equal(una.rounds.length, 2, "round 2 ran and found nothing");
  assert.equal(una.status.a, "disputed");
  assert.equal(una.counts.unanswered, 1);
  assert.deepEqual(copiedPhraseTargets(una.unresolved), ["a"]);
});

test("prompt additions: prior rounds block for round 2 and the last-round note", () => {
  const prior: ReviewRound[] = [
    { round: 1, findings: [{ ...rf("ch01", "copied_phrase"), finding_id: "r1f01" }], responses: [{ finding_id: "r1f01", action: "declined", reason: "固有名" }] },
  ];
  const block = priorRoundsBlock(prior, 2, 2);
  assert.match(block, /第2回レビューで、これが最後/);
  assert.match(block, /r1f01 \[copied_phrase\] 対象 ch01: .* → declined（固有名）/);
  assert.equal(priorRoundsBlock([], 1, 2), "");
  assert.match(lastRoundNote(1, 2), /もう一度レビューがあります/);
  assert.match(lastRoundNote(2, 2), /最後の対応.*disputed.*削除/s);
});

test("deleteDrafts: removes the element, edges touching it, refs to it; nulls changed_by", () => {
  const drafts: Draft[] = [
    { _type: "Character", id: "ch01", label: "甲" },
    { _type: "Character", id: "ch02", label: "乙" },
    { _type: "Event", id: "ev01", label: "事件" },
    { _type: "Event", id: "ev02", label: "決裂" },
    { _type: "Relation", id: "rl01", from: "ch01", to: "ch02", changed_by: "ev01" },
    { _type: "Causes", id: "cs01", from: "ev01", to: "ev02" },
    { _type: "Theme", id: "th01", label: "主題", based_on: ["ch01", "ev01"] },
    { _type: "Explains", id: "xp01", from: "th01", to: "th01", refs: ["ev01", "ev02"] },
  ];
  const r = deleteDrafts(drafts, ["ev01"]);
  assert.deepEqual(r.deleted, [{ id: "ev01", type: "Event" }]);
  assert.deepEqual(r.cascaded, [{ id: "cs01", type: "Causes", because_of: "ev01" }]);
  const by = new Map(r.drafts.map((d) => [d.id, d] as const));
  assert.ok(!by.has("ev01") && !by.has("cs01"));
  assert.equal(by.get("rl01")!.changed_by, null);
  assert.deepEqual(by.get("th01")!.based_on, ["ch01"]);
  assert.deepEqual(by.get("xp01")!.refs, ["ev02"]);
  assert.deepEqual(drafts.find((d) => d.id === "th01")!.based_on, ["ch01", "ev01"], "input not mutated");
  assert.equal(deleteDrafts(drafts, []).drafts, drafts);
});

test("structuralZeros: Relation needs ≥2 Characters + M01; Causes needs ≥2 Events; fact layer only", () => {
  const on = new Set(["M01", "M03"]);
  assert.deepEqual(structuralZeros({ Character: 2, Event: 3 }, on, "fact"), [
    { type: "Relation", basis: "Character", basis_count: 2 },
    { type: "Causes", basis: "Event", basis_count: 3 },
  ]);
  assert.deepEqual(structuralZeros({ Character: 2, Relation: 1, Event: 2, Causes: 1 }, on, "fact"), []);
  assert.deepEqual(structuralZeros({ Character: 1, Event: 1 }, on, "fact"), []);
  assert.deepEqual(structuralZeros({ Character: 2 }, new Set(["M03"]), "fact"), [], "M01 disabled");
  assert.deepEqual(structuralZeros({ Character: 2, Event: 2 }, on, "interp"), []);
});

test("buildFactLayer: unresolved copied_phrase deletes the element; too_concrete → advisory + disputed → confidence −1; zeroed types and structural zeros warn (no throw)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rvl-"));
  try {
    makeFixtureWork(dir);
    const calls: FakeCall[] = [];
    let reviews = 0;
    const raised = new Set<string>();
    const handler = (req: Parameters<typeof cannedS2>[0]): unknown => {
      const g = (p: Record<string, unknown[]>) => fillGroup(req.schema, p);
      switch (req.task) {
        case "s2.fact.events":
          return g({
            events: [
              mNode({ id: "ev01", label: "事件発生", claim_refs: ["c0006"], phase_ref: "ph1", story_order: 1, disclosure_phase: "ph1" }),
              mNode({ id: "ev02", label: "真相の露見", claim_refs: ["c0007"], phase_ref: "ph3", story_order: 2, disclosure_phase: "ph3" }),
            ],
            causes: [mEdge({ id: "cs01", from: "ev01", to: "ev02", kind: "causes", claim_refs: ["c0006"] })],
          });
        case "s2.fact.people":
          return g({
            characters: [mNode({ id: "ch01", label: "人物甲", claim_refs: ["c0003"] }), mNode({ id: "ch02", label: "人物乙", claim_refs: ["c0004"] })],
            relations: [mEdge({ id: "rl01", from: "ch01", to: "ch02", kind: "盟友", valence: "positive", phase_from: null, phase_to: null, changed_by: null, claim_refs: ["c0003"] })],
          });
        case "s2.fact.world":
          return g({ contexts: [mNode({ id: "cx01", label: "受賞", kind: "award", claim_refs: ["c0027"] })] });
        case "s2.fact.review": {
          reviews++;
          // A14 reviews each group separately. Only raise findings for its own elements,
          // once; a fresh round must leave declined copied_phrase unresolved.
          const own = JSON.parse(req.prompt.match(/# レビュー対象（JSON）\n([^\n]+)/)![1]!);
          const ids = new Set(Object.values(own).flatMap(v => (v as {id:string}[]).map(n => n.id)));
          const findings = [rf("rl01", "copied_phrase"), rf("ev02", "too_concrete"), rf("cs01", "unsupported")]
            .filter(f => ids.has(f.target_id) && !raised.has(f.target_id));
          findings.forEach(f => raised.add(f.target_id));
          return { findings };
        }
        case "s2.fact.revise": {
          assert.match(req.prompt, /これは第1回の対応です/);
          const findings = [...req.prompt.matchAll(/- (r\d+f\d+) \[([^/]+)\/[^\]]+\] 対象 ([^:]+):/g)];
          return {
            responses: findings.map(([, finding_id, type]) => ({
              finding_id,
              action: type === "unsupported" ? "revised" : "declined",
              reason: type === "unsupported" ? "因果は言えないので外した" : "十分抽象的な固有名だけ",
            })),
            updated: fillGroup((req.schema as { properties: { updated: object } }).properties.updated, {}),
            removed_ids: findings.some(([, , , target]) => target === "cs01") ? ["cs01"] : [],
          };
        }
        default:
          return cannedS2(req);
      }
    };
    const logs: string[] = [];
    const ctx = fixtureContext(dir, fakePort("luna", handler, calls), fakePort("haiku", handler, calls), logs);
    await selectModules(ctx);
    await buildPhases(ctx);
    const r = await buildFactLayer(ctx);
    assert.equal(reviews, 6, "three review groups across two rounds");
    assert.equal(r.metrics.rounds, 2);
    assert.equal(r.metrics.deleted_copied_phrase, 1);
    assert.equal(r.metrics.advisory, 1);
    assert.equal(r.metrics.zeroed_types, 2);
    assert.equal(r.metrics.structural_zero, 2);
    assert.ok(r.warnings.includes("review_zeroed_type: Relation (1 → 0)"), r.warnings.join("\n"));
    assert.ok(r.warnings.includes("review_zeroed_type: Causes (1 → 0)"));
    assert.ok(r.warnings.includes("structural_zero: Relation"));
    assert.ok(r.warnings.includes("structural_zero: Causes"));
    assert.ok(r.warnings.some((w) => w.includes("rl01") && w.includes("copied_phrase")));

    const layer = read(dir, "nkg/layers/fact.json");
    assert.ok(!layer.drafts.some((d: Draft) => d.id === "rl01"), "rl01 deleted (C-2)");
    assert.ok(!("rl01" in layer.status));
    assert.equal(layer.status.ev02, "disputed");
    assert.equal(layer.status.ch01, "agreed");

    const rv = read(dir, "nkg/reviews/fact.json");
    assert.equal(rv.max_rounds, 2);
    assert.deepEqual(rv.deleted, [{ id: "rl01", type: "Relation", reason: "copied_phrase" }]);
    assert.deepEqual(rv.advisory.map((a: { target_id: string; type: string }) => `${a.target_id}:${a.type}`), ["ev02:too_concrete"]);
    assert.deepEqual(rv.unresolved.map((u: { target_id: string }) => u.target_id).sort(), ["ev02", "rl01"]);
    assert.deepEqual(rv.zeroed_types, [
      { type: "Causes", before: 1, after: 0 },
      { type: "Relation", before: 1, after: 0 },
    ]);
    assert.deepEqual(rv.structural_zero.map((z: { type: string }) => z.type), ["Relation", "Causes"]);
    assert.deepEqual(rv.status_counts, { agreed: 4, revised: 0, disputed: 1 }, "ev01 ch01 ch02 cx01 agreed; cs01 removed by the author");

    // quality metrics
    const sum = read(dir, "nkg/review_summary.json");
    const fact = sum.stages.find((s: { stage: string }) => s.stage === "s2.fact");
    assert.deepEqual(
      { rounds: fact.rounds, findings: fact.findings, revised: fact.revised, declined: fact.declined, disputed: fact.disputed, deleted: fact.deleted, advisory: fact.advisory },
      { rounds: 2, findings: 3, revised: 1, declined: 2, disputed: 1, deleted: 1, advisory: 1 },
    );
    assert.deepEqual(fact.findings_by_type, { copied_phrase: 1, too_concrete: 1, unsupported: 1 });
    assert.deepEqual(fact.zeroed_types.sort(), ["Causes", "Relation"]);
    assert.equal(read(dir, "work.json").review_stats.deleted, 1);

    // disputed → meta.review = disputed and confidence one grade lower, through the real assemble path
    const asm = await assembleNkg(ctx);
    const nkg = read(dir, "nkg/nkg.json") as Nkg;
    assert.equal(validateNkg(nkg).ok, true, JSON.stringify(validateNkg(nkg).errors));
    assert.ok(asm.warnings.some((w) => w.includes("interp layer not generated")));
    const ev02 = nkg.nodes.find((n) => n.id === "ev02")!;
    assert.equal(ev02.meta.review, "disputed");
    assert.equal(ev02.meta.confidence.grade, "B", "c0007 → s1 (T1) = A, disputed → B");
    assert.match(ev02.meta.confidence.basis, /disputed −1$/);
    const ev01 = nkg.nodes.find((n) => n.id === "ev01")!;
    assert.equal(ev01.meta.review, "agreed");
    assert.equal(ev01.meta.confidence.grade, "A");
    assert.ok(!nkg.edges.some((e) => e.id === "rl01" || e.id === "cs01"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeReviews: generic reader over claims / nkg / gen review files; merges review_stats into work.json only", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rvs-"));
  try {
    const w = (rel: string, data: unknown) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), typeof data === "string" ? data : JSON.stringify(data));
    };
    const cf = (target_id: string | null, type: string) => ({ target_id, type, severity: "low", evidence: "e", missing_aspect: null, suggested_query: null });
    w("research/claims_review.json", [
      {
        round: 1, batch: 1, at: "t", claim_ids: ["c1", "c2", "c3"],
        findings: [cf("c1", "copied_phrase"), cf("c2", "overreach"), cf("c3", "unsupported"), cf(null, "missing")],
        actions: [{ claim_id: "c1", action: "keep" }, { claim_id: "c2", action: "revise" }],
        outcomes: [
          { claim_id: "c1", review: "disputed", status: "active", drop_reason: null },
          { claim_id: "c2", review: "revised", status: "active", drop_reason: null },
          { claim_id: "c3", review: "disputed", status: "active", drop_reason: null },
        ],
        missing: [], advisory: [], deleted: [],
      },
      {
        round: 2, batch: 1, at: "t", claim_ids: ["c1", "c3"],
        findings: [cf("c3", "unsupported")],
        actions: [{ claim_id: "c3", action: "keep" }],
        outcomes: [
          { claim_id: "c1", review: "pending", status: "dropped", drop_reason: "copied_phrase" },
          { claim_id: "c3", review: "disputed", status: "active", drop_reason: null },
        ],
        missing: [], advisory: [{ target_id: "c3", type: "unsupported", severity: "low", evidence: "e", round: 2 }], deleted: ["c1"],
      },
    ]);
    // M1-shaped layer file (no WP-2.1 fields)
    w("nkg/reviews/fact.json", {
      layer: "fact", max_rounds: 1,
      rounds: [{ round: 1, findings: [{ target_id: "ev01", type: "misclassified", finding_id: "r1f01" }, { target_id: "ch01", type: "overreach", finding_id: "r1f02" }], responses: [{ finding_id: "r1f01", action: "revised", reason: "ok" }, { finding_id: "r1f02", action: "declined", reason: "no_response (treated as declined by code)" }] }],
      counts: { findings: 2, revised: 1, declined: 0, unanswered: 1, rounds: 1 },
    });
    // S3-style file: several reviewed units in one array
    w("gen/reviews/pages.json", [
      { max_rounds: 2, rounds: [{ round: 1, findings: [{ target_id: "p1", type: "too_concrete", finding_id: "r1f01" }], responses: [{ finding_id: "r1f01", action: "declined", reason: "x" }] }, { round: 2, findings: [], responses: [] }], unresolved: [{ target_id: "p1", types: ["too_concrete"] }], advisory: [{ target_id: "p1", type: "too_concrete" }] },
      { max_rounds: 2, rounds: [{ round: 1, findings: [], responses: [] }] },
    ]);
    w("gen/reviews/broken.json", "{ not json");
    w("work.json", { work_id: "x", title: "題", genres: ["mystery"], review_stats: { old: true } });

    const { summary, output, workUpdated } = summarizeReviews(dir, new Date("2026-11-23T00:00:00Z"));
    assert.equal(output, "nkg/review_summary.json");
    assert.equal(workUpdated, true);
    assert.deepEqual(summary.stages.map((s) => s.stage), ["s1.claims", "s2.fact", "s3.pages"]);
    const [cl, fa, pg] = summary.stages;
    assert.deepEqual(
      { r: cl.rounds, f: cl.findings, rv: cl.revised, d: cl.declined, u: cl.unanswered, dis: cl.disputed, del: cl.deleted, adv: cl.advisory },
      { r: 2, f: 5, rv: 1, d: 2, u: 1, dis: 1, del: 1, adv: 1 },
    );
    assert.deepEqual(cl.findings_by_type, { copied_phrase: 1, overreach: 1, unsupported: 2, missing: 1 });
    assert.deepEqual({ r: fa.rounds, rv: fa.revised, u: fa.unanswered, dis: fa.disputed, max: fa.max_rounds }, { r: 1, rv: 1, u: 1, dis: 1, max: 1 });
    assert.deepEqual({ r: pg.rounds, f: pg.findings, dis: pg.disputed, adv: pg.advisory, d: pg.declined }, { r: 2, f: 1, dis: 1, adv: 1, d: 1 });
    assert.equal(summary.totals.findings, 8);
    assert.equal(summary.totals.rounds_max, 2);
    assert.deepEqual(summary.skipped.map((s) => s.file), ["gen/reviews/broken.json"]);

    const work = read(dir, "work.json");
    assert.deepEqual(work.genres, ["mystery"]);
    assert.equal(work.title, "題");
    assert.deepEqual(work.review_stats.rounds, { "s1.claims": 2, "s2.fact": 1, "s3.pages": 2 });
    assert.equal(work.review_stats.deleted, 1);
    assert.equal(work.review_stats.updated_at, "2026-11-23T00:00:00.000Z");
    assert.ok(!("old" in work.review_stats));
    assert.deepEqual(read(dir, "nkg/review_summary.json"), JSON.parse(JSON.stringify(summary)));

    // idempotent, and no work.json → summary only
    assert.deepEqual(computeReviewSummary(dir, new Date("2026-11-23T00:00:00Z")), summary);
    rmSync(path.join(dir, "work.json"));
    assert.equal(summarizeReviews(dir).workUpdated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
