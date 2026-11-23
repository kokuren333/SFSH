import { urlMatchKey } from "./candidates.ts";
import { readCandidates, readFetchLog, readSources } from "./researchIo.ts";
import type { BudgetState } from "./types.ts";

/**
 * AMENDMENT 12: research "frames" (the plot frame vs the analysis frame) and per-stage allowances inside the job
 * budget (§1.3: search 40 / fetch 60 stay the hard caps; a frame only decides how much of them a stage may use and
 * how much it must leave for the later stages).
 */

/** URL match key → source id, from the cards (url / final_url) and fetch decisions that carry a known card id. */
export function sourceIdByUrlKey(workDir: string): Map<string, string> {
  const cards = readSources(workDir);
  const sidByKey = new Map<string, string>();
  const known = new Set(cards.map((c) => c.source_id));
  for (const c of cards) {
    for (const u of [c.url, c.final_url]) {
      const k = typeof u === "string" ? urlMatchKey(u) : null;
      if (k && !sidByKey.has(k)) sidByKey.set(k, c.source_id);
    }
  }
  for (const d of readFetchLog(workDir)) {
    const k = urlMatchKey(d.url);
    if (k && d.sourceId && known.has(d.sourceId) && !sidByKey.has(k)) sidByKey.set(k, d.sourceId);
  }
  return sidByKey;
}

/** Source ids whose selected candidate (any round / job of this work) carries `aspect` (e.g. "plot"). */
export function sourceIdsForAspect(workDir: string, aspect: string): Set<string> {
  const sidByKey = sourceIdByUrlKey(workDir);
  const out = new Set<string>();
  const want = aspect.toLowerCase();
  for (const cand of readCandidates(workDir).selected) {
    if (!(cand.aspects ?? []).some((a) => String(a).trim().split(/\s+/)[0]?.toLowerCase() === want)) continue;
    const k = urlMatchKey(cand.url);
    const sid = k ? sidByKey.get(k) : undefined;
    if (sid) out.add(sid);
  }
  return out;
}

/** What one stage may still use: min(its own cap, what is left after the reserve kept for later stages). */
export interface Allowance {
  searches: number;
  fetches: number;
}

export function allowance(budget: BudgetState, cap: Allowance, reserve: Allowance = { searches: 0, fetches: 0 }): Allowance {
  return {
    searches: Math.max(0, Math.min(cap.searches, budget.limits.searches - budget.searchesUsed - reserve.searches)),
    fetches: Math.max(0, Math.min(cap.fetches, budget.limits.fetches - budget.fetchesUsed - reserve.fetches)),
  };
}

/** Milliseconds left on the research wall clock (§1.3: 30 minutes from the job start; fetches stop after it). */
export function wallLeftMs(budget: BudgetState, now: Date): number {
  return budget.limits.wallMs - (now.getTime() - Date.parse(budget.startedAt));
}

/**
 * Frame plan [暫定, A12]. Stage caps inside the job budget (40 / 60 with the identification counted in) and the
 * reserves each stage leaves for the stages after it, in pipeline order:
 *   search_plot (plot frame) → search_r1 (analysis frame) → followup (coverage loop) → gapfill (after the fact layer).
 */
export interface FramePlan {
  plot: { cap: Allowance; reserve: Allowance };
  analysis: { cap: Allowance; reserve: Allowance };
  coverage: { cap: Allowance; reserve: Allowance };
  gapfill: { cap: Allowance; reserve: Allowance };
}

export const FRAMES: FramePlan = {
  plot: { cap: { searches: 12, fetches: 22 }, reserve: { searches: 18, fetches: 22 } },
  analysis: { cap: { searches: 10, fetches: 14 }, reserve: { searches: 10, fetches: 12 } },
  coverage: { cap: { searches: 40, fetches: 60 }, reserve: { searches: 8, fetches: 10 } },
  gapfill: { cap: { searches: 40, fetches: 60 }, reserve: { searches: 0, fetches: 0 } },
};

/** No frame caps or reserves (every stage sees the whole job budget). Tests of the fetch path use it with tiny budgets. */
const OPEN = { cap: { searches: Number.POSITIVE_INFINITY, fetches: Number.POSITIVE_INFINITY }, reserve: { searches: 0, fetches: 0 } };
export const OPEN_FRAMES: FramePlan = { plot: OPEN, analysis: OPEN, coverage: OPEN, gapfill: OPEN };
