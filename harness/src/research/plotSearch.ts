import { isoLocal } from "../model/callLog.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { pool } from "../util/pool.ts";
import { allowance, FRAMES } from "./frames.ts";
import type { WorkBrief } from "./prompts/common.ts";
import { buildPlotSearchPrompt, PLOT_MAX_SELECTIONS, TARGET_MAX_SELECTIONS } from "./prompts/search.ts";
import { appendGaps, readFetchLog, readSources, RESEARCH_FILES } from "./researchIo.ts";
import { lunaSearch, processSearch, type CallOutcome } from "./search.ts";

/**
 * AMENDMENT 12 plot frame (stage `search_plot`, first research stage): sources that let the story be followed as a
 * chain of events from the start to the ending (official STORY / episode guides, publisher synopses, encyclopedia
 * synopsis sections and episode lists, work databases). Kept apart from the analysis frame (`search_r1`) by its own
 * allowance inside the job budget (frames.ts). Every selection carries the aspect "plot", so claim extraction treats
 * these sources with the event-granular instruction.
 *
 * Calls: one main call over the whole story, plus segment calls for the ending and the middle (run in parallel with
 * the main call; their candidates are fetched after the main call's, within the same allowance).
 */

export const PLOT_MAIN_SEARCHES = 8;
export const PLOT_SEGMENTS = ["結末（最終回・最終章・ラストで何が起きたか）", "中盤（物語が大きく転じる局面）"];
export const PLOT_SEGMENT_SEARCHES = 2;

export async function runPlotSearch(ctx: StageContext, opts: { work: WorkBrief }): Promise<StageResult> {
  const warnings: string[] = [];
  const outputs = new Set<string>();
  const fr = (ctx.frames ?? FRAMES).plot;
  const allow = allowance(ctx.budget, fr.cap, fr.reserve);
  if (allow.searches <= 0) {
    const detail = `plot frame skipped: no search allowance (budget ${ctx.budget.searchesUsed}/${ctx.budget.limits.searches}, reserve ${fr.reserve.searches})`;
    appendGaps(ctx.workDir, [{ kind: "budget_exhausted", aspect: "plot", detail, at: isoLocal(ctx.now()) }]);
    return { outputs: [RESEARCH_FILES.gaps], metrics: { searches: 0, fetched: 0, gets: 0, calls: 0 }, warnings: [detail] };
  }
  const mainCap = Math.min(PLOT_MAIN_SEARCHES, allow.searches);
  const segs = PLOT_SEGMENTS.slice(0, Math.max(0, Math.floor((allow.searches - mainCap) / PLOT_SEGMENT_SEARCHES)));
  const avoid = [...new Set([...readSources(ctx.workDir).map((c) => c.url), ...readFetchLog(ctx.workDir).map((d) => d.url)])];
  const calls = [
    { segment: null as string | null, cap: mainCap, maxSel: PLOT_MAX_SELECTIONS },
    ...segs.map((segment) => ({ segment, cap: PLOT_SEGMENT_SEARCHES, maxSel: TARGET_MAX_SELECTIONS })),
  ];
  const task = "s1.search.plot";
  const called = await pool(calls, 3, async (c) => {
    try {
      return await lunaSearch(ctx, task, buildPlotSearchPrompt({ work: opts.work, maxSearches: c.cap, segment: c.segment, avoidUrls: avoid, maxSelections: c.maxSel }));
    } catch (e) {
      return e as Error;
    }
  });
  if (called[0] instanceof Error) throw called[0]; // the main call failing = stage retry (4.4)
  let getsLeft = allow.fetches;
  const outs: { segment: string | null; r: CallOutcome }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = called[i]!;
    if (c instanceof Error) {
      warnings.push(`${task} [${calls[i]!.segment}]: segment call failed (continuing): ${c.message.slice(0, 200)}`);
      continue;
    }
    const r = await processSearch(ctx, c, {
      task,
      callId: `${ctx.jobId}:${task}:${i + 1}:${ctx.now().getTime().toString(36)}`,
      prompt: "",
      cap: calls[i]!.cap,
      instr: [],
      warnings,
      outputs,
      logExtra: { frame: "plot", segment: calls[i]!.segment },
      skipKnown: true,
      maxSelections: calls[i]!.maxSel,
      fetchCap: Math.max(0, getsLeft),
      forceAspects: ["plot"],
    });
    getsLeft -= r.gets;
    outs.push({ segment: calls[i]!.segment, r });
  }
  const sum = (f: (r: CallOutcome) => number) => outs.reduce((s, o) => s + f(o.r), 0);
  const metrics = {
    calls: calls.length,
    searches: sum((r) => r.searches),
    results: sum((r) => r.rec.results.length),
    selected: sum((r) => r.filtered.selected.length),
    rejected: sum((r) => r.filtered.rejected.length),
    rejected_self_reported: sum((r) => r.selfReported),
    fetched: sum((r) => r.fetched),
    skipped: sum((r) => r.skipped),
    gets: sum((r) => r.gets),
    deferred: sum((r) => r.deferred),
    allowance_searches: allow.searches,
    allowance_fetches: allow.fetches,
  };
  ctx.log(`${task}: calls=${metrics.calls} searches=${metrics.searches} selected=${metrics.selected} fetched=${metrics.fetched} gets=${metrics.gets}/${allow.fetches} deferred=${metrics.deferred}`);
  return { outputs: [...outputs], metrics, warnings };
}
