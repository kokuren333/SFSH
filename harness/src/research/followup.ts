import { isoLocal } from "../model/callLog.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { extractClaims } from "./claims.ts";
import { reviewClaims } from "./claimReview.ts";
import { REVIEW_MAX_ROUNDS } from "../nkg/review.ts";
import type { Claim, MissingAspect } from "./claimTypes.ts";
import type { WorkBrief } from "./prompts/common.ts";
import { appendGaps, RESEARCH_FILES, readClaims, readClaimsReview, readSources } from "./researchIo.ts";
import { runSearch } from "./search.ts";
import type { ResearchGap } from "./types.ts";

/**
 * S1 follow-up (WP-1.3): one extra search → fetch → claims → review round for Haiku's `missing` aspects
 * and for core modules with too few active claims. Aspects still short afterwards become gaps (P-1).
 */

/** Always-on modules checked for sufficiency (REQUIREMENTS §2.4). */
export const CORE_MODULES = ["M01", "M02", "M03", "M06", "M07", "M10", "M12"] as const;
/** [暫定] minimum active claims per core module. */
export const MIN_CLAIMS_PER_MODULE = 3;
export const FOLLOWUP_MAX_SEARCHES = 8;

export interface FollowUpOptions {
  work: WorkBrief;
  minClaimsPerModule?: number;
  /** Missing aspects to cover; defaults to every `missing` finding in claims_review.json. */
  missing?: MissingAspect[];
  maxSearches?: number;
  /** Review rounds for the new claims (default REVIEW_MAX_ROUNDS = 2, §3.3-2). */
  reviewRounds?: number;
}

export function countActiveByAspect(claims: Claim[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of claims) if (c.status === "active") for (const a of c.aspects) out[a] = (out[a] ?? 0) + 1;
  return out;
}

export function shortCoreModules(claims: Claim[], min: number): string[] {
  const counts = countActiveByAspect(claims);
  return CORE_MODULES.filter((m) => (counts[m] ?? 0) < min);
}

export async function followUp(ctx: StageContext, opts: FollowUpOptions): Promise<StageResult> {
  const min = opts.minClaimsPerModule ?? MIN_CLAIMS_PER_MODULE;
  const before = readClaims(ctx.workDir);
  const missing = opts.missing ?? readClaimsReview(ctx.workDir).flatMap((e) => e.missing ?? []);

  const aspects: string[] = [];
  const hints: string[] = [];
  for (const m of missing) {
    const a = (m.aspect ?? "").trim();
    if (a && !aspects.includes(a)) aspects.push(a);
    if (m.suggested_query && !hints.includes(m.suggested_query)) hints.push(m.suggested_query);
  }
  const shortBefore = shortCoreModules(before, min);
  for (const m of shortBefore) if (!aspects.includes(m)) aspects.push(m);

  if (aspects.length === 0) {
    ctx.log("s1.followup: nothing missing, skipped");
    return { outputs: [], metrics: { triggered: 0, aspects: 0 }, warnings: [] };
  }

  const warnings: string[] = [];
  const outputs = new Set<string>();
  const metrics: Record<string, number | string> = { triggered: 1, aspects: aspects.length, aspect_list: aspects.join(",") };

  const srcBefore = new Set(readSources(ctx.workDir).map((c) => c.source_id));
  const sr = await runSearch(ctx, { round: 2, aspects, work: opts.work, maxSearches: opts.maxSearches ?? FOLLOWUP_MAX_SEARCHES, hints });
  sr.outputs.forEach((o) => outputs.add(o));
  warnings.push(...sr.warnings);
  metrics.searches = sr.metrics.searches ?? 0;
  metrics.fetched = sr.metrics.fetched ?? 0;

  const newSources = readSources(ctx.workDir).map((c) => c.source_id).filter((id) => !srcBefore.has(id));
  let newClaimIds: string[] = [];
  if (newSources.length) {
    const claimIdsBefore = new Set(readClaims(ctx.workDir).map((c) => c.claim_id));
    const er = await extractClaims(ctx, { sourceIds: newSources, workTitle: opts.work.title });
    er.outputs.forEach((o) => outputs.add(o));
    warnings.push(...er.warnings);
    metrics.extracted = er.metrics.extracted ?? 0;
    newClaimIds = readClaims(ctx.workDir).filter((c) => !claimIdsBefore.has(c.claim_id) && c.status === "active").map((c) => c.claim_id);
    if (newClaimIds.length) {
      const rr = await reviewClaims(ctx, { claimIds: newClaimIds, maxRounds: opts.reviewRounds ?? REVIEW_MAX_ROUNDS, workTitle: opts.work.title });
      rr.outputs.forEach((o) => outputs.add(o));
      warnings.push(...rr.warnings);
      metrics.reviewed = rr.metrics.reviewed ?? 0;
    }
  }
  metrics.new_sources = newSources.length;

  // What is still short becomes a gap (never stops the job).
  const after = readClaims(ctx.workDir);
  const counts = countActiveByAspect(after);
  const newActive = after.filter((c) => newClaimIds.includes(c.claim_id) && c.status === "active").length;
  metrics.new_active_claims = newActive;
  const at = isoLocal(ctx.now());
  const gaps: ResearchGap[] = [];
  for (const a of aspects) {
    const isModule = /^(bibliographic|title|genre|M(0[1-9]|1[0-2]))$/.test(a);
    const short = isModule ? (counts[a] ?? 0) < min : newActive === 0;
    if (short) {
      gaps.push({
        kind: "no_sources_for_aspect",
        aspect: a,
        detail: isModule ? `${counts[a] ?? 0} active claim(s) after follow-up (< ${min})` : "follow-up produced no new active claims for this aspect",
        at,
      });
    }
  }
  if (gaps.length) {
    appendGaps(ctx.workDir, gaps);
    outputs.add(RESEARCH_FILES.gaps);
    warnings.push(`s1.followup: still short: ${gaps.map((g) => g.aspect).join(", ")}`);
  }
  metrics.still_short = gaps.length;
  ctx.log(`s1.followup: aspects=${aspects.length} new_sources=${newSources.length} new_active_claims=${newActive} still_short=${gaps.length}`);
  return { outputs: [...outputs], metrics, warnings };
}
