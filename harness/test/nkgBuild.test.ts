import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strictSchemaViolations } from "../src/model/validate.ts";
import { assembleNkg, buildFactLayer, buildInterpLayer, buildPhases } from "../src/nkg/build.ts";
import { FACT_GROUPS, INTERP_GROUPS, SPECS, groupSchema } from "../src/nkg/elements.ts";
import { finalizeLayers } from "../src/nkg/finalize.ts";
import { selectModules } from "../src/nkg/modules.ts";
import { PHASES_SCHEMA } from "../src/nkg/prompts/layers.ts";
import { FINDINGS_SCHEMA, runReviewLoop } from "../src/nkg/review.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";
import { cannedS2, fixtureClaims, fixtureContext, makeFixtureWork } from "../src/nkg/testWork.ts";
import type { Nkg, NkgNode } from "../src/nkg/types.ts";
import { validateNkg } from "../src/nkg/validate.ts";

const read = (dir: string, rel: string) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));

test("all Luna-facing S2 schemas are OpenAI-strict", () => {
  assert.deepEqual(strictSchemaViolations(PHASES_SCHEMA), []);
  assert.deepEqual(strictSchemaViolations(FINDINGS_SCHEMA), []);
  for (const g of [...FACT_GROUPS, ...INTERP_GROUPS]) assert.deepEqual(strictSchemaViolations(groupSchema(g.kinds.map((k) => SPECS[k]))), [], g.name);
});

test("runReviewLoop: agreed / revised / disputed / unanswered, maxRounds honoured", async () => {
  type S = string[];
  let reviews = 0;
  const out = await runReviewLoop<S>({
    initial: ["a", "b", "c", "d"],
    maxRounds: 2,
    ids: (s) => s,
    review: async (_s, round) => {
      reviews++;
      return round === 1
        ? [
            { target_id: "a", type: "overreach", severity: "low", evidence: "x" },
            { target_id: "b", type: "unsupported", severity: "high", evidence: "y" },
            { target_id: "c", type: "copied_phrase", severity: "high", evidence: "z" },
          ]
        : [{ target_id: "b", type: "unsupported", severity: "high", evidence: "again" }];
    },
    revise: async (s, findings, round) => ({
      state: s,
      responses:
        round === 1
          ? [
              { finding_id: findings[0].finding_id, action: "revised", reason: "ok" },
              { finding_id: findings[1].finding_id, action: "declined", reason: "no" },
              // c left unanswered
            ]
          : [{ finding_id: findings[0].finding_id, action: "revised", reason: "fixed now" }],
    }),
  });
  assert.equal(reviews, 2);
  assert.deepEqual(out.status, { a: "revised", b: "revised", c: "disputed", d: "agreed" });
  assert.deepEqual(out.counts, { findings: 4, revised: 2, declined: 1, unanswered: 1, rounds: 2 });

  const one = await runReviewLoop<S>({
    initial: ["a"],
    maxRounds: 1,
    ids: (s) => s,
    review: async () => [{ target_id: "a", type: "overreach", severity: "low", evidence: "x" }],
    revise: async (s, f) => ({ state: s, responses: [{ finding_id: f[0].finding_id, action: "declined", reason: "no" }] }),
  });
  assert.equal(one.rounds.length, 1);
  assert.equal(one.status.a, "disputed");
});

test("finalize: claim_refs → provenance; no basis → rejected; based_on only → inferred sfsh_analysis", () => {
  const claims = new Map(fixtureClaims().filter((c) => c.status === "active").map((c) => [c.claim_id, c] as const));
  const sources = new Map([
    ["s1", { source_id: "s1", tier: "T1" as const, site_key: "pub" }],
    ["s2", { source_id: "s2", tier: "T3" as const, site_key: "wiki" }],
  ]);
  const r = finalizeLayers(
    [
      {
        layer: "fact",
        author: "luna",
        drafts: [
          { _type: "Character", id: "ch01", label: "甲", claim_refs: ["c0003"], based_on: [], epistemic: "canon", spoiler: "none" },
          { _type: "Character", id: "ch02", label: "乙", claim_refs: ["c9999"], based_on: [], epistemic: "canon", spoiler: "none" },
        ],
        status: { ch01: "disputed" },
      },
      {
        layer: "interp",
        author: "haiku",
        drafts: [
          { _type: "Theme", id: "th01", label: "主題", question: "q", values: [], tension: "t", claim_refs: [], based_on: ["ch01"], epistemic: "consensus", spoiler: "none" },
          { _type: "Theme", id: "th02", label: "循環", question: "q", values: [], tension: "t", claim_refs: [], based_on: ["th03"], epistemic: "sfsh_analysis", spoiler: "none" },
          { _type: "Theme", id: "th03", label: "循環", question: "q", values: [], tension: "t", claim_refs: [], based_on: ["th02"], epistemic: "sfsh_analysis", spoiler: "none" },
        ],
        status: {},
      },
    ],
    { claims, sources, phaseIds: new Set(["ph1", "ph2", "ph3"]), enabled: new Set(["M01", "M10"]), defaultCoverage: "全体" },
  );
  const byId = new Map(r.nodes.map((n) => [n.id, n] as const));
  const ch01 = byId.get("ch01")!;
  assert.deepEqual(ch01.meta.provenance, [
    { source_id: "s1", locator: "claim:c0003", support: "direct" },
    { source_id: "s2", locator: "claim:c0003", support: "direct" },
  ]);
  assert.equal(ch01.meta.authored_by, "luna");
  assert.equal(ch01.meta.reviewed_by, "haiku");
  assert.equal(ch01.meta.review, "disputed");
  assert.equal(ch01.meta.confidence.grade, "B", "T1 → A, disputed → B");
  assert.ok(!byId.has("ch02"));
  assert.deepEqual(r.rejections.find((x) => x.id === "ch02")?.reason.startsWith("no_basis"), true);
  const th01 = byId.get("th01")!;
  assert.equal(th01.meta.epistemic, "sfsh_analysis");
  assert.ok(th01.meta.provenance.every((p) => p.support === "inferred"));
  assert.equal(th01.meta.authored_by, "haiku");
  assert.equal(th01.meta.reviewed_by, "luna");
  assert.ok(!byId.has("th02") && !byId.has("th03"), "a based_on cycle has no provenance → rejected");
});

test("full chain selectModules → phases → fact → interp → assemble produces a valid NKG", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nkgb-"));
  try {
    makeFixtureWork(dir);
    const calls: FakeCall[] = [];
    const logs: string[] = [];
    // WP-2.1: two rounds; the second (fresh) review of each layer finds nothing → early stop
    const reviewed = new Set<string>();
    const handler = (req: Parameters<typeof cannedS2>[0]) => {
      if (/^s2\.(fact|interp)\.review$/.test(req.task)) {
        if (reviewed.has(req.task)) {
          assert.match(req.prompt, /前回までの指摘と作成側の回答（今回は第2回レビューで、これが最後）/);
          assert.match(req.prompt, /r1f01/);
          return { findings: [] };
        }
        reviewed.add(req.task);
      }
      if (/^s2\.(fact|interp)\.revise$/.test(req.task)) assert.match(req.prompt, /これは第1回の対応です（最大2往復）/);
      return cannedS2(req);
    };
    const ctx = fixtureContext(dir, fakePort("luna", handler, calls), fakePort("haiku", handler, calls), logs);

    await selectModules(ctx);
    const ph = await buildPhases(ctx);
    assert.equal(ph.metrics.phases, 3);
    const phasesFile = read(dir, "nkg/phases.json");
    assert.deepEqual(phasesFile.phases.map((p: { id: string; label: string }) => `${p.id}:${p.label}`), ["ph1:序盤", "ph2:中盤", "ph3:結末"]);
    assert.deepEqual(phasesFile.phases[1].claim_refs, ["c0008"], "unknown claim ids dropped");

    const fact = await buildFactLayer(ctx);
    assert.equal(fact.metrics.findings, 3);
    assert.equal(fact.metrics.revised, 2);
    assert.equal(fact.metrics.declined, 1);
    assert.equal(fact.metrics.rejected, 2, "ch09 (unknown claim) and ch10 (dropped claim)");
    const interp = await buildInterpLayer(ctx);
    assert.equal(interp.metrics.findings, 1);
    assert.equal(interp.metrics.revised, 1);
    assert.ok(Number(interp.metrics.rejected) >= 3);
    const asm = await assembleNkg(ctx);

    // call order & ports: events before people before world; authors/reviewers opposite
    assert.deepEqual(
      calls.map((c) => `${c.port}:${c.req.task}`),
      [
        "luna:s2.genre",
        "haiku:s2.modules.review",
        "luna:s2.phases",
        "haiku:s2.phases.review",
        "luna:s2.fact.events",
        "luna:s2.fact.people",
        "luna:s2.fact.world",
        "haiku:s2.fact.review",
        "luna:s2.fact.revise",
        "haiku:s2.fact.review",
        "haiku:s2.interp.reverse_plot",
        "haiku:s2.interp.motives_arcs",
        "haiku:s2.interp.themes_emotion",
        "haiku:s2.interp.extras",
        "luna:s2.interp.review",
        "haiku:s2.interp.revise",
        "luna:s2.interp.review",
      ],
    );
    for (const c of calls.filter((c) => /\.(events|people|world|reverse_plot|motives_arcs|themes_emotion|extras)$/.test(c.req.task))) {
      assert.equal(c.req.timeoutMs, 600_000, c.req.task);
      assert.match(c.req.prompt, /台詞/);
      assert.match(c.req.prompt, /自分の言葉/);
      assert.match(c.req.prompt, /日本語/);
      assert.equal(c.req.jobId, "job-test");
    }
    // world group only asked for the enabled M12 types (M08 / M09 insufficient)
    const world = calls.find((c) => c.req.task === "s2.fact.world")!;
    assert.deepEqual(Object.keys((world.req.schema as { properties: object }).properties), ["contexts", "about"]);
    const motives = calls.find((c) => c.req.task === "s2.interp.motives_arcs")!;
    assert.deepEqual(Object.keys((motives.req.schema as { properties: object }).properties), ["motives", "drives", "conflicts"], "M07 insufficient → no arcs");

    const nkg = read(dir, "nkg/nkg.json") as Nkg;
    const v = validateNkg(nkg);
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
    assert.equal(asm.metrics.validation_ok, 1);
    assert.equal(read(dir, "nkg/validation.json").ok, true);

    const byId = new Map(nkg.nodes.map((n) => [n.id, n] as const));
    // claim_refs → provenance (code-assigned)
    assert.deepEqual(byId.get("ch02")!.meta.provenance, [
      { source_id: "s1", locator: "claim:c0003", support: "direct" },
      { source_id: "s2", locator: "claim:c0003", support: "direct" },
      { source_id: "s1", locator: "claim:c0004", support: "direct" },
    ]);
    // rejected elements are absent and logged
    const report = read(dir, "nkg/build_report.json");
    const rejectedIds = report.rejections.map((r: { id: string }) => r.id).sort();
    assert.deepEqual(rejectedIds, ["ch09", "ch10", "mo03", "qz02", "th02"]);
    for (const id of rejectedIds) assert.ok(!byId.has(id), id);
    // authored_by ≠ reviewed_by everywhere; layers authored by the right model
    for (const el of [...nkg.nodes, ...nkg.edges]) assert.notEqual(el.meta.authored_by, el.meta.reviewed_by, el.id);
    assert.equal(byId.get("ev01")!.meta.authored_by, "luna");
    assert.equal(byId.get("th01")!.meta.authored_by, "haiku");
    // review states
    assert.equal(byId.get("ch02")!.meta.review, "disputed");
    assert.equal(byId.get("ch02")!.meta.confidence.grade, "B", "T1+T3 → A, disputed → B");
    assert.match(byId.get("ch02")!.meta.confidence.basis, /disputed −1$/);
    assert.equal(byId.get("ch01")!.meta.review, "agreed");
    assert.equal(byId.get("ch01")!.meta.confidence.grade, "A");
    assert.equal(byId.get("ev02")!.meta.review, "revised");
    assert.equal(byId.get("ev02")!.label, "真相の開示");
    assert.equal(byId.get("fa01")!.meta.review, "revised", "element added in revision");
    assert.equal(byId.get("th01")!.meta.review, "revised");
    assert.equal((byId.get("th01") as NkgNode & { analysis?: string }).analysis, "修正稿");
    // based_on-only analysis → inferred provenance, forced sfsh_analysis
    const wy02 = byId.get("wy02")!;
    assert.equal(wy02.meta.epistemic, "sfsh_analysis");
    assert.ok(wy02.meta.provenance.length > 0 && wy02.meta.provenance.every((p) => p.support === "inferred"));
    // wy01 is canon on a single T3 source (grade C) → not canon-eligible → wy02 (based on it) is not eligible either
    assert.equal(v.elements.wy01.public_eligible, false);
    assert.equal(v.elements.wy02.public_eligible, false);
    assert.match(v.elements.wy02.reasons.join(" "), /wy01/);
    assert.equal(v.elements.ch01.public_eligible, true);
    assert.equal(v.elements.th01.public_eligible, false, "based on ev03 (canon, T3 only → C)");
    // ref cleanup
    const rl02 = nkg.edges.find((e) => e.id === "rl02")!;
    assert.equal(rl02.type === "Relation" && rl02.changed_by, null, "changed_by pointing to a Character is nulled");
    const mo02 = byId.get("mo02")!;
    assert.equal(mo02.type === "Motive" && mo02.phase_to, null);
    const im01 = byId.get("im01")!;
    assert.deepEqual(im01.type === "IconicMoment" && im01.context_refs, ["cx01"]);
    const ip01 = byId.get("ip01")!;
    assert.equal(ip01.type === "Interpretation" && ip01.positions.length, 2, "position without claims dropped");
    const kn02 = nkg.edges.find((e) => e.id === "kn02")!;
    assert.equal(kn02.from, "audience");
    // gaps actually used
    const gapModules = nkg.gaps.map((g) => g.module);
    for (const m of ["M07", "M08", "M09"]) assert.ok(gapModules.includes(m as never), m);
    assert.ok(!nkg.nodes.some((n) => n.type === "Arc"));
    // M04 kept disclosure_phase; work block
    assert.equal(byId.get("ev03")!.type === "Event" && (byId.get("ev03") as { disclosure_phase: string }).disclosure_phase, "ph2");
    assert.deepEqual(nkg.work.genres, ["mystery", "human_drama"]);
    assert.deepEqual(nkg.work.title_alt, ["試験"]);
    assert.deepEqual(nkg.work.creators, [{ name: "作者甲", role: null }]);
    assert.equal(nkg.work.phases.length, 3);
    // sources: bibliographic subset only (no excerpts)
    for (const s of nkg.sources) assert.deepEqual(Object.keys(s).sort(), ["fetched_at", "license", "publisher", "site_key", "source_id", "tier", "title", "url"]);
    // review files
    for (const l of ["fact", "interp"]) {
      assert.ok(existsSync(path.join(dir, "nkg", "reviews", `${l}.json`)));
      const rv = read(dir, `nkg/reviews/${l}.json`);
      assert.equal(rv.max_rounds, 2);
      assert.equal(rv.rounds.length, 2, "round 2 ran and found nothing → stop");
      assert.deepEqual(rv.rounds[1].findings, []);
      assert.equal(rv.rounds[0].responses.length, rv.rounds[0].findings.length, "every finding answered");
      assert.deepEqual(rv.deleted, []);
      assert.deepEqual(rv.zeroed_types, []);
      assert.deepEqual(rv.structural_zero, []);
    }
    // ch02's declined overreach stays unresolved → advisory (not deleted)
    assert.deepEqual(
      read(dir, "nkg/reviews/fact.json").advisory.map((a: { target_id: string; type: string }) => `${a.target_id}:${a.type}`),
      ["ch02:overreach"],
    );
    // quality metrics (§3.3-4)
    const sum = read(dir, "nkg/review_summary.json");
    assert.deepEqual(sum.stages.map((s: { stage: string }) => s.stage), ["s2.fact", "s2.interp"]);
    assert.equal(sum.totals.findings, 4);
    assert.equal(sum.totals.disputed, 1);
    assert.equal(sum.totals.advisory, 1);
    const work = read(dir, "work.json");
    assert.deepEqual(work.review_stats.rounds, { "s2.fact": 2, "s2.interp": 2 });
    assert.equal(work.title, "試験作品", "other work.json fields untouched");

    // idempotent: assemble again yields identical nkg.json
    await assembleNkg(ctx);
    assert.deepEqual(read(dir, "nkg/nkg.json"), nkg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemble: modules with no surviving elements become gaps", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nkgg-"));
  try {
    makeFixtureWork(dir);
    // world group returns nothing usable → M12 must become a gap; extras empty → extra gaps
    const handler = (req: Parameters<typeof cannedS2>[0]) => {
      if (req.task === "s2.fact.world") return { contexts: [], about: [] };
      if (req.task === "s2.interp.extras") return { iconic_moments: [], interpretations: [], quizzes: [] };
      return cannedS2(req);
    };
    const ctx = fixtureContext(dir, fakePort("luna", handler), fakePort("haiku", handler));
    await selectModules(ctx);
    await buildPhases(ctx);
    await buildFactLayer(ctx);
    await buildInterpLayer(ctx);
    await assembleNkg(ctx);
    const nkg = read(dir, "nkg/nkg.json") as Nkg;
    assert.equal(validateNkg(nkg).ok, true);
    const gm = nkg.gaps.map((g) => `${g.module}:${g.reason}`);
    assert.ok(gm.includes("M12:insufficient_sources"), gm.join(","));
    assert.equal(nkg.gaps.filter((g) => g.module === "extra").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize (CP-027): a phase LABEL where an id is required maps to the id; unknown stays rejected", () => {
  const claims = new Map(fixtureClaims().filter((c) => c.status === "active").map((c) => [c.claim_id, c] as const));
  const sources = new Map([["s1", { source_id: "s1", tier: "T1" as const, site_key: "pub" }]]);
  const r = finalizeLayers(
    [
      {
        layer: "interp",
        author: "haiku",
        drafts: [
          { _type: "EmotionBeat", id: "eb01", label: "緊張", phase: "序盤", emotion: "不安", intensity: 3, cause_refs: [], claim_refs: ["c0003"], based_on: [], epistemic: "sfsh_analysis", spoiler: "none" },
          { _type: "EmotionBeat", id: "eb02", label: "安堵", phase: "ph2", emotion: "安堵", intensity: 2, cause_refs: [], claim_refs: ["c0003"], based_on: [], epistemic: "sfsh_analysis", spoiler: "none" },
          { _type: "EmotionBeat", id: "eb03", label: "謎", phase: "存在しない段", emotion: "困惑", intensity: 2, cause_refs: [], claim_refs: ["c0003"], based_on: [], epistemic: "sfsh_analysis", spoiler: "none" },
        ],
        status: {},
      },
    ],
    {
      claims,
      sources,
      phaseIds: new Set(["ph1", "ph2"]),
      phaseByLabel: new Map([["序盤", "ph1"], ["結末", "ph2"]]),
      enabled: new Set(["M11"]),
      defaultCoverage: "全体",
    },
  );
  const byId = new Map(r.nodes.map((n) => [n.id, n] as const));
  assert.equal((byId.get("eb01") as { phase: string }).phase, "ph1");
  assert.equal((byId.get("eb02") as { phase: string }).phase, "ph2");
  assert.ok(!byId.has("eb03"));
  assert.ok(r.notes.some((n) => n.id === "eb01" && n.note.includes("→ ph1")));
});
