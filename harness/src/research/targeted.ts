import fs from "node:fs";
import { stageWidth } from "../util/parallel.ts";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { buildFactLayer, buildPhases } from "../nkg/build.ts";
import { selectModules } from "../nkg/modules.ts";
import { pool } from "../util/pool.ts";
import { extractClaims } from "./claims.ts";
import { reviewClaims } from "./claimReview.ts";
import { appendCoverage, claimCoverage, factCoverage, readCoverage, type CoverageShortfall } from "./coverage.ts";
import { CORE_MODULES, MIN_CLAIMS_PER_MODULE, countActiveByAspect } from "./followup.ts";
import { allowance, FRAMES, wallLeftMs, type Allowance } from "./frames.ts";
import { ASPECT_GUIDE, type WorkBrief } from "./prompts/common.ts";
import { buildTargetSearchPrompt, TARGET_MAX_SELECTIONS } from "./prompts/search.ts";
import { appendGaps, RESEARCH_FILES, readClaims, readClaimsReview, readFetchLog, readSources } from "./researchIo.ts";
import { lunaSearch, processSearch, type CallOutcome } from "./search.ts";
import type { ResearchGap } from "./types.ts";

/**
 * AMENDMENT 12: coverage-driven follow-up research.
 *
 *  - `followup` (S1, after claims_r1, before review_r1): measure claim coverage (coverage.ts) → targeted rounds
 *    (one narrow Luna web_search per shortfall, in parallel → fetch within the frame allowance → claims for the new
 *    sources) while goals are unmet, the budget allows and enough research wall clock is left for the post-NKG
 *    round. The new claims are reviewed by review_r1 together with the rest.
 *  - `gapfill` (after S2 fact): measure the NKG fact layer (events per phase, main characters in events, ending) and
 *    the claims again → targeted rounds for the thin parts only → review of the new claims.
 *  - `refact`: when gapfill added active claims, re-run modules → phases → fact so the NKG uses them; measure again.
 *
 * Every measurement and round goes to research/coverage.json; unmet goals at the end become research gaps
 * (kind coverage_shortfall). Nothing here stops the job (P-1); the budget (40 / 60 / 30 min) is never raised.
 */

/**
 * [暫定, A12] review rounds of the rebuilt fact layer in `refact` (≤ REVIEW_MAX_ROUNDS = 2, §3.3). One round keeps the
 * stage (modules + phases + fact with the larger claim set) inside one ten-minute work unit; the first fact build of the
 * job keeps two rounds.
 */
export const REFACT_REVIEW_ROUNDS = 1;

/** [暫定, A12] */
export const TARGETED = {
  /** targets per round (one Luna call each) and searches per target */
  maxTargets: 6,
  searchesPerTarget: 2,
  /** page GETs per target (top-up allowed when some candidates are skipped) */
  fetchesPerTarget: 4,
  /** parallel Luna web_search calls */
  /** A12 value; since A14 the width is parallel.json stages.search (default 6) */
  concurrency: 3,
  followupMaxRounds: 3,
  gapfillMaxRounds: 2,
  /**
   * followup starts a round only when at least this much research wall clock is left, so that review_r1 → modules →
   * phases → fact can finish and the post-NKG gapfill round can still fetch (§1.3 wall clock 30 min).
   */
  followupWallReserveMs: 20 * 60_000,
  /** gapfill starts a round only when fetches can still happen (search + fetch take ~2 min) */
  gapfillWallMinMs: 3 * 60_000,
  /** analysis-frame targets (short core modules / Haiku "missing" aspects) per stage */
  maxAspectTargets: 2,
};

export interface TargetResult {
  key: string;
  target: string;
  searches: number;
  selected: number;
  fetched: number;
  gets: number;
  failed?: string;
}

export interface RoundResult {
  targets: TargetResult[];
  searches: number;
  gets: number;
  newSources: string[];
  newActive: number;
  newPlot: number;
  newClaimIds: string[];
}

function avoidUrls(workDir: string): string[] {
  return [...new Set([...readSources(workDir).map((c) => c.url), ...readFetchLog(workDir).map((d) => d.url)])];
}

/**
 * One targeted round: parallel Luna calls (one per shortfall) → sequential processing in priority order (budget,
 * logs, candidate filter, fetch within the allowance) → claims for the new sources (plot frame when the target is a
 * plot target). No review here (the caller reviews).
 */
export async function targetedRound(
  ctx: StageContext,
  o: { work: WorkBrief; shortfalls: CoverageShortfall[]; allow: Allowance; stage: string; round: number; warnings: string[]; outputs: Set<string> },
): Promise<RoundResult> {
  const per = TARGETED.searchesPerTarget;
  const n = Math.min(TARGETED.maxTargets, o.shortfalls.length, Math.floor(o.allow.searches / per));
  const targets = o.shortfalls.slice(0, n);
  const result: RoundResult = { targets: [], searches: 0, gets: 0, newSources: [], newActive: 0, newPlot: 0, newClaimIds: [] };
  if (!targets.length) return result;
  const avoid = avoidUrls(ctx.workDir);
  const task = `s1.${o.stage}.r${o.round}`;
  const called = await pool(targets, stageWidth("search"), async (t) => { // A14: parallel.json stages.search
    try {
      return await lunaSearch(ctx, task, buildTargetSearchPrompt({ work: o.work, target: t.target, aspects: t.aspects, maxSearches: per, hints: t.hints, avoidUrls: avoid }));
    } catch (e) {
      return e as Error;
    }
  });
  const srcBefore = new Set(readSources(ctx.workDir).map((c) => c.source_id));
  let getsLeft = o.allow.fetches;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const c = called[i]!;
    if (c instanceof Error) {
      o.warnings.push(`${task} [${t.key}]: search call failed (continuing): ${c.message.slice(0, 200)}`);
      result.targets.push({ key: t.key, target: t.target, searches: 0, selected: 0, fetched: 0, gets: 0, failed: c.message.slice(0, 120) });
      continue;
    }
    let r: CallOutcome;
    try {
      r = await processSearch(ctx, c, {
        task,
        callId: `${ctx.jobId}:${task}:${i + 1}:${ctx.now().getTime().toString(36)}`,
        prompt: "",
        cap: per,
        instr: [],
        warnings: o.warnings,
        outputs: o.outputs,
        logExtra: { targeted: true, stage: o.stage, round: o.round, target_key: t.key },
        skipKnown: true,
        maxSelections: TARGET_MAX_SELECTIONS,
        fetchCap: Math.max(0, Math.min(TARGETED.fetchesPerTarget, getsLeft)),
        forceAspects: t.aspects,
      });
    } catch (e) {
      o.warnings.push(`${task} [${t.key}]: processing failed (continuing): ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    getsLeft -= r.gets;
    result.searches += r.searches;
    result.gets += r.gets;
    result.targets.push({ key: t.key, target: t.target, searches: r.searches, selected: r.filtered.selected.length, fetched: r.fetched, gets: r.gets });
  }
  result.newSources = readSources(ctx.workDir).map((c) => c.source_id).filter((id) => !srcBefore.has(id));
  if (result.newSources.length) {
    const before = new Set(readClaims(ctx.workDir).map((c) => c.claim_id));
    try {
      const er = await extractClaims(ctx, { sourceIds: result.newSources, workTitle: o.work.title, focus: targets.map((t) => t.target) });
      er.outputs.forEach((x) => o.outputs.add(x));
      o.warnings.push(...er.warnings);
    } catch (e) {
      o.warnings.push(`${task}: claim extraction failed (continuing): ${(e as Error).message.slice(0, 200)}`);
    }
    const fresh = readClaims(ctx.workDir).filter((c) => !before.has(c.claim_id) && c.status === "active");
    result.newClaimIds = fresh.map((c) => c.claim_id);
    result.newActive = fresh.length;
    result.newPlot = fresh.filter((c) => c.aspects.includes("plot")).length;
  }
  return result;
}

/** Analysis-frame shortfalls: core modules with too few active claims, then Haiku's "missing" aspects. */
export function aspectShortfalls(workDir: string, includeMissing: boolean): CoverageShortfall[] {
  const claims = readClaims(workDir);
  const counts = countActiveByAspect(claims);
  const guide = (a: string) => ASPECT_GUIDE.split("\n").find((l) => l.startsWith(`${a} =`))?.split("=")[1]?.trim() ?? a;
  const out: CoverageShortfall[] = [];
  for (const m of CORE_MODULES) {
    const n = counts[m] ?? 0;
    if (n < MIN_CLAIMS_PER_MODULE) out.push({ key: `aspect:${m}`, kind: "aspect", target: `${m}（${guide(m)}）を裏づける事実・見方`, aspects: [m], detail: `${m} の有効 claim ${n}（目標 ${MIN_CLAIMS_PER_MODULE}）` });
  }
  if (includeMissing) {
    for (const e of readClaimsReview(workDir)) {
      for (const m of e.missing ?? []) {
        const a = (m.aspect ?? "").trim();
        if (!a || out.some((x) => x.key === `aspect:${a}`)) continue;
        out.push({ key: `aspect:${a}`, kind: "aspect", target: `${a}（${guide(a)}）: ${m.note}`.slice(0, 160), aspects: [/^(M(0[1-9]|1[0-2])|bibliographic|title|genre|plot)$/.test(a) ? a : "M03"], detail: `査読の missing: ${m.note}`.slice(0, 160), hints: m.suggested_query ? [m.suggested_query] : undefined });
      }
    }
  }
  return out.slice(0, TARGETED.maxAspectTargets);
}

function budgetNote(ctx: StageContext) {
  const b = ctx.budget;
  return { searches: b.searchesUsed, fetches: b.fetchesUsed, limits: `${b.limits.searches}/${b.limits.fetches}` };
}

function dedupe(xs: CoverageShortfall[]): CoverageShortfall[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)));
}

/** Interleave plot shortfalls (ending first) with at most a couple of analysis targets. */
function prioritise(plot: CoverageShortfall[], aspects: CoverageShortfall[]): CoverageShortfall[] {
  const [first, ...rest] = plot;
  return dedupe([...(first ? [first] : []), ...aspects.slice(0, 1), ...rest.slice(0, 2), ...aspects.slice(1), ...rest.slice(2)]);
}

interface LoopOptions {
  stage: "followup" | "gapfill";
  work: WorkBrief;
  maxRounds: number;
  frame: { cap: Allowance; reserve: Allowance };
  wallMinMs: number;
  /** shortfalls for the current state (recomputed each round) */
  shortfalls: (round: number) => CoverageShortfall[];
  coverageNow: () => ReturnType<typeof claimCoverage> | ReturnType<typeof factCoverage>;
}

async function coverageLoop(ctx: StageContext, o: LoopOptions, warnings: string[], outputs: Set<string>) {
  const rounds: RoundResult[] = [];
  let stopped = "max_rounds";
  for (let round = 1; round <= o.maxRounds; round++) {
    const sf = o.shortfalls(round);
    if (!sf.length) {
      stopped = "goals_met";
      break;
    }
    const allow = allowance(ctx.budget, o.frame.cap, o.frame.reserve);
    if (allow.searches < TARGETED.searchesPerTarget) {
      stopped = `search_allowance (${allow.searches} left after reserve)`;
      break;
    }
    if (allow.fetches <= 0) {
      stopped = `fetch_allowance (0 left after reserve)`;
      break;
    }
    const left = wallLeftMs(ctx.budget, ctx.now());
    if (left < o.wallMinMs) {
      stopped = `wall_clock (${Math.round(left / 1000)}s left < ${Math.round(o.wallMinMs / 1000)}s needed)`;
      break;
    }
    const r = await targetedRound(ctx, { work: o.work, shortfalls: sf, allow, stage: o.stage, round, warnings, outputs });
    rounds.push(r);
    appendCoverage(ctx.workDir, {
      at: isoLocal(ctx.now()),
      job_id: ctx.jobId,
      stage: o.stage,
      event: "round",
      round,
      targets: r.targets,
      new_sources: r.newSources.length,
      new_plot_claims: r.newPlot,
      new_active_claims: r.newActive,
      budget: budgetNote(ctx),
      coverage: o.coverageNow(),
    });
    ctx.log(`s1.${o.stage}: round ${round} targets=${r.targets.length} searches=${r.searches} gets=${r.gets} new_sources=${r.newSources.length} new_active=${r.newActive} (plot ${r.newPlot})`);
    if (r.newActive === 0) {
      stopped = "no_new_claims";
      break;
    }
  }
  return { rounds, stopped };
}

function recordUnmet(ctx: StageContext, stage: string, shortfalls: CoverageShortfall[], outputs: Set<string>): void {
  if (!shortfalls.length) return;
  const at = isoLocal(ctx.now());
  const gaps: ResearchGap[] = shortfalls.map((s) => ({ kind: "coverage_shortfall", aspect: s.key, detail: `${stage}: ${s.detail}`, at }));
  appendGaps(ctx.workDir, gaps);
  outputs.add(RESEARCH_FILES.gaps);
}

function sumRounds(rounds: RoundResult[]) {
  return {
    rounds: rounds.length,
    targets: rounds.reduce((s, r) => s + r.targets.length, 0),
    searches: rounds.reduce((s, r) => s + r.searches, 0),
    gets: rounds.reduce((s, r) => s + r.gets, 0),
    new_sources: rounds.reduce((s, r) => s + r.newSources.length, 0),
    new_active_claims: rounds.reduce((s, r) => s + r.newActive, 0),
    new_plot_claims: rounds.reduce((s, r) => s + r.newPlot, 0),
  };
}

// ------------------------------------------------------------------ stage: followup (S1, before review_r1)

export async function coverageFollowUp(ctx: StageContext, opts: { work: WorkBrief; maxRounds?: number }): Promise<StageResult> {
  const warnings: string[] = [];
  const outputs = new Set<string>([RESEARCH_FILES.claims]);
  const before = claimCoverage(readClaims(ctx.workDir));
  appendCoverage(ctx.workDir, { at: isoLocal(ctx.now()), job_id: ctx.jobId, stage: "followup", event: "detect", round: 0, coverage: before, budget: budgetNote(ctx) });
  outputs.add("research/coverage.json");
  const loop = await coverageLoop(
    ctx,
    {
      stage: "followup",
      work: opts.work,
      maxRounds: opts.maxRounds ?? TARGETED.followupMaxRounds,
      frame: (ctx.frames ?? FRAMES).coverage,
      wallMinMs: TARGETED.followupWallReserveMs,
      shortfalls: (round) => prioritise(claimCoverage(readClaims(ctx.workDir)).shortfalls, round === 1 ? aspectShortfalls(ctx.workDir, false) : []),
      coverageNow: () => claimCoverage(readClaims(ctx.workDir)),
    },
    warnings,
    outputs,
  );
  const after = claimCoverage(readClaims(ctx.workDir));
  appendCoverage(ctx.workDir, { at: isoLocal(ctx.now()), job_id: ctx.jobId, stage: "followup", event: "detect", round: loop.rounds.length, coverage: after, budget: budgetNote(ctx), stopped_because: loop.stopped });
  if (!after.met) warnings.push(`s1.followup: coverage goals still unmet (${after.shortfalls.length}): ${after.shortfalls.map((s) => s.key).join(", ")} — stopped: ${loop.stopped}`);
  const s = sumRounds(loop.rounds);
  ctx.log(`s1.followup: shortfalls ${before.shortfalls.length} → ${after.shortfalls.length}, plot claims ${before.plot_claims} → ${after.plot_claims}, stopped: ${loop.stopped}`);
  return {
    outputs: [...outputs],
    metrics: {
      ...s,
      shortfalls_before: before.shortfalls.length,
      shortfalls_after: after.shortfalls.length,
      plot_claims_before: before.plot_claims,
      plot_claims_after: after.plot_claims,
      goals_met: after.met ? 1 : 0,
      stopped: loop.stopped,
      shortfall_keys_after: after.shortfalls.map((x) => x.key).join(","),
    },
    warnings,
  };
}

// ------------------------------------------------------------------ stage: gapfill (after S2 fact)

interface FactLayerLite {
  drafts: { _type: string; id: string }[];
}

function readFact(workDir: string): { drafts: FactLayerLite["drafts"]; phases: { id: string; label: string; scope?: string }[] } {
  const f = path.join(workDir, "nkg", "layers", "fact.json");
  const p = path.join(workDir, "nkg", "phases.json");
  const drafts = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as FactLayerLite).drafts ?? [] : [];
  const phases = fs.existsSync(p) ? ((JSON.parse(fs.readFileSync(p, "utf8")) as { phases: { id: string; label: string; scope?: string }[] }).phases ?? []) : [];
  return { drafts, phases };
}

export function currentFactCoverage(workDir: string) {
  const { drafts, phases } = readFact(workDir);
  return factCoverage(drafts as never, phases);
}

export async function gapFill(ctx: StageContext, opts: { work: WorkBrief; maxRounds?: number }): Promise<StageResult> {
  const warnings: string[] = [];
  const outputs = new Set<string>(["research/coverage.json"]);
  const factBefore = currentFactCoverage(ctx.workDir);
  const claimBefore = claimCoverage(readClaims(ctx.workDir));
  appendCoverage(ctx.workDir, { at: isoLocal(ctx.now()), job_id: ctx.jobId, stage: "gapfill", event: "detect", round: 0, coverage: factBefore, budget: budgetNote(ctx) });
  // fact-layer shortfalls first (what the NKG actually lacks), then the claim-level ones not already covered
  const shortfalls = (round: number) => {
    const fact = round === 1 ? factBefore.shortfalls : [];
    const claim = claimCoverage(readClaims(ctx.workDir)).shortfalls;
    return prioritise(dedupe([...fact, ...claim]), round === 1 ? aspectShortfalls(ctx.workDir, true) : []);
  };
  const loop = await coverageLoop(
    ctx,
    {
      stage: "gapfill",
      work: opts.work,
      maxRounds: opts.maxRounds ?? TARGETED.gapfillMaxRounds,
      frame: (ctx.frames ?? FRAMES).gapfill,
      wallMinMs: TARGETED.gapfillWallMinMs,
      shortfalls,
      coverageNow: () => claimCoverage(readClaims(ctx.workDir)),
    },
    warnings,
    outputs,
  );
  const newIds = loop.rounds.flatMap((r) => r.newClaimIds);
  let reviewed = 0;
  if (newIds.length) {
    try {
      const rr = await reviewClaims(ctx, { claimIds: newIds, workTitle: opts.work.title });
      rr.outputs.forEach((x) => outputs.add(x));
      warnings.push(...rr.warnings);
      reviewed = Number(rr.metrics.reviewed ?? 0);
    } catch (e) {
      warnings.push(`s1.gapfill: review of new claims failed (they stay pending): ${(e as Error).message.slice(0, 200)}`);
    }
  }
  const active = new Set(readClaims(ctx.workDir).filter((c) => c.status === "active").map((c) => c.claim_id));
  const keptNew = newIds.filter((id) => active.has(id)).length;
  const claimAfter = claimCoverage(readClaims(ctx.workDir));
  appendCoverage(ctx.workDir, { at: isoLocal(ctx.now()), job_id: ctx.jobId, stage: "gapfill", event: "detect", round: loop.rounds.length, coverage: claimAfter, budget: budgetNote(ctx), stopped_because: loop.stopped, new_active_claims: keptNew });
  const s = sumRounds(loop.rounds);
  ctx.log(`s1.gapfill: fact shortfalls ${factBefore.shortfalls.length}, rounds ${s.rounds}, new active claims ${keptNew} after review, stopped: ${loop.stopped}`);
  return {
    outputs: [...outputs],
    metrics: {
      ...s,
      fact_shortfalls_before: factBefore.shortfalls.length,
      fact_shortfall_keys: factBefore.shortfalls.map((x) => x.key).join(","),
      claim_shortfalls_before: claimBefore.shortfalls.length,
      claim_shortfalls_after: claimAfter.shortfalls.length,
      reviewed,
      new_active_after_review: keptNew,
      stopped: loop.stopped,
    },
    warnings,
  };
}

// ------------------------------------------------------------------ stage: refact (rebuild the fact layer when gapfill added claims)

export async function refact(ctx: StageContext): Promise<StageResult> {
  const warnings: string[] = [];
  const last = [...readCoverage(ctx.workDir)].reverse().find((r) => r.stage === "gapfill" && r.event === "detect" && r.job_id === ctx.jobId);
  const added = last?.new_active_claims ?? 0;
  const outputs = new Set<string>(["research/coverage.json"]);
  const metrics: Record<string, number | string> = { new_claims_from_gapfill: added, rebuilt: 0 };
  if (added > 0) {
    for (const [name, fn] of [["modules", selectModules], ["phases", buildPhases], ["fact", (c: StageContext) => buildFactLayer(c, REFACT_REVIEW_ROUNDS)]] as const) {
      const r = await fn(ctx);
      r.outputs.forEach((x) => outputs.add(x));
      warnings.push(...r.warnings.map((w) => `${name}: ${w}`));
      for (const [k, v] of Object.entries(r.metrics)) metrics[`${name}_${k}`] = v;
    }
    metrics.rebuilt = 1;
  }
  const after = currentFactCoverage(ctx.workDir);
  appendCoverage(ctx.workDir, { at: isoLocal(ctx.now()), job_id: ctx.jobId, stage: "refact", event: "detect", coverage: after, budget: budgetNote(ctx) });
  const finalClaims = claimCoverage(readClaims(ctx.workDir));
  // unmet goals at the end of research = information shortage (gaps), never a stop
  recordUnmet(ctx, "coverage (fact layer)", after.shortfalls, outputs);
  recordUnmet(ctx, "coverage (claims)", finalClaims.shortfalls, outputs);
  const aspectsShort = aspectShortfalls(ctx.workDir, false);
  recordUnmet(ctx, "coverage (analysis frame)", aspectsShort, outputs);
  metrics.aspect_shortfall_keys_final = aspectsShort.map((x) => x.key).join(",");
  metrics.fact_events = after.events;
  metrics.fact_shortfalls_after = after.shortfalls.length;
  metrics.fact_shortfall_keys_after = after.shortfalls.map((x) => x.key).join(",");
  metrics.claim_shortfalls_final = finalClaims.shortfalls.length;
  metrics.claim_shortfall_keys_final = finalClaims.shortfalls.map((x) => x.key).join(",");
  metrics.plot_claims_final = finalClaims.plot_claims;
  ctx.log(`s2.refact: rebuilt=${metrics.rebuilt} events=${after.events} fact shortfalls ${after.shortfalls.length}, claim shortfalls ${finalClaims.shortfalls.length}`);
  return { outputs: [...outputs], metrics, warnings };
}
