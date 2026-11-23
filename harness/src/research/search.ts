import { isoLocal } from "../model/callLog.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { filterSelections, recordSearchCall, urlMatchKey, type CandidateFilterResult, type ModelSelection, type SearchCallRecord } from "./candidates.ts";
import { ASPECT_GUIDE, type WorkBrief } from "./prompts/common.ts";
import { buildSearchPrompt, buildSupplementPrompt, MAX_SELECTIONS, SEARCH_SCHEMA, SUPPLEMENT_MAX_SELECTIONS } from "./prompts/search.ts";
import {
  appendCandidates,
  appendFetchLog,
  appendGaps,
  appendSearchLog,
  appendSources,
  RESEARCH_FILES,
  readCandidates,
  readFetchLog,
  readSearchLog,
  readSources,
  writeBudget,
} from "./researchIo.ts";
import type { ResearchGap, Tier } from "./types.ts";

/**
 * S1 search stage (PLAN §3). One Luna web_search call plans and runs searches; candidate URLs are taken
 * only from the call's web_search events (or instruction URLs) via filterSelections (§1.3-1). The fetcher
 * (WP-1.2) is the only component that GETs pages and creates source cards (§1.3-2).
 *
 * Code-driven supplement (CP-029 finding a, M3): after the main call of round 1, the code computes which of the
 * requested aspects still have no source card mapped to them (via selected candidates' `aspects`). When the main
 * call ran fewer than SUPPLEMENT_MIN_SEARCHES searches or some aspect is uncovered, it issues extra narrow Luna
 * web_search calls, one per aspect (uncovered first, in the given aspect order; then the least-covered ones when
 * only the search count is low), at most SUPPLEMENT_MAX_CALLS per round and only within the job's search budget
 * (minus a reserve kept for the follow-up round). Their candidates go through the same filterSelections /
 * fetcher path. A failing supplement call is a warning, never a stage failure (P-1).
 */

export const DEFAULT_SEARCH_ASPECTS = [
  "bibliographic",
  "M01 人物と関係",
  "M03 プロットの因果",
  "M08 世界観・ルール",
  "M10 テーマ",
  "M12 受容・受賞・批評",
];

export const DEFAULT_MAX_SEARCHES = 12;
export const SEARCH_TIMEOUT_MS = 600_000;

/** Supplement trigger: the main call ran fewer web searches than this (= the prompt's stated minimum). */
export const SUPPLEMENT_MIN_SEARCHES = 6;
/** Max supplement calls per round. */
export const SUPPLEMENT_MAX_CALLS = 4;
/** Search cap stated in each supplement prompt (the budget still counts the events, §1.3-1). */
export const SUPPLEMENT_SEARCHES_PER_CALL = 2;
/**
 * Searches kept free for the follow-up round (runner: followUp maxSearches 8): supplements of round 1 only use
 * `limits.searches - searchesUsed - reserve`. With the default budget (40) this never binds in practice.
 */
export const SUPPLEMENT_RESERVE_SEARCHES = 8;

export interface SupplementOptions {
  /** Default: true for round 1, false otherwise (the follow-up round is already aspect-targeted). */
  enabled?: boolean;
  minSearches?: number;
  maxCalls?: number;
  searchesPerCall?: number;
  reserveSearches?: number;
}

export interface RunSearchOptions {
  round: number;
  aspects: string[];
  work: WorkBrief;
  maxSearches?: number;
  instructionUrls?: { url: string; note: string }[];
  /** Extra query ideas (e.g. Haiku's suggested queries in follow-up). */
  hints?: string[];
  /** Code-driven search supplement (CP-029 finding a). `false` disables it. */
  supplement?: SupplementOptions | false;
}

interface SearchOutput {
  selections: { url: string; why: string; aspects: string[]; tier_suggested: Tier | null }[];
  notes: string | null;
}

/** search_log.json record of a supplement call (extra keys on top of SearchCallRecord). */
export type SupplementSearchRecord = SearchCallRecord & { supplement: true; aspect: string };

/** Leading token of an aspect label, lower-cased: "M10 テーマ" → "m10", "bibliographic" → "bibliographic". */
export function aspectKey(a: string): string {
  return (String(a ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * Number of distinct source cards mapped to each aspect, from what the code already records: a selected
 * candidate (research/candidates.json, any round / job of this work) with that aspect whose URL has a source
 * card (sources.json url / final_url, or a fetch_log decision carrying the card's source id).
 */
export function aspectCoverage(workDir: string, aspects: string[]): Map<string, number> {
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
  const byAspect = new Map<string, Set<string>>();
  for (const cand of readCandidates(workDir).selected) {
    const k = urlMatchKey(cand.url);
    const sid = k ? sidByKey.get(k) : undefined;
    if (!sid) continue;
    for (const a of cand.aspects ?? []) {
      const ak = aspectKey(a);
      if (!byAspect.has(ak)) byAspect.set(ak, new Set());
      byAspect.get(ak)!.add(sid);
    }
  }
  return new Map(aspects.map((a) => [a, byAspect.get(aspectKey(a))?.size ?? 0] as const));
}

/** Supplement targets: uncovered aspects (given order), then — only to make up a low search count — least-covered ones. */
export function supplementTargets(coverage: Map<string, number>, searchesMain: number, o: Required<Omit<SupplementOptions, "enabled">>): { targets: string[]; uncovered: string[] } {
  const order = [...coverage.keys()];
  const uncovered = order.filter((a) => (coverage.get(a) ?? 0) === 0);
  const shortBy = Math.max(0, o.minSearches - searchesMain);
  const forCount = shortBy > 0 ? Math.ceil(shortBy / Math.max(1, o.searchesPerCall)) : 0;
  const wanted = Math.min(o.maxCalls, Math.max(uncovered.length, forCount));
  const weak = order
    .filter((a) => (coverage.get(a) ?? 0) > 0)
    .map((a, i) => ({ a, n: coverage.get(a)!, i }))
    .sort((x, y) => x.n - y.n || x.i - y.i)
    .map((x) => x.a);
  return { targets: [...uncovered, ...weak].slice(0, wanted), uncovered };
}

function guideLine(aspect: string): string {
  const k = aspectKey(aspect);
  return ASPECT_GUIDE.split("\n").find((l) => aspectKey(l.split("=")[0]) === k) ?? aspect;
}

interface CallOutcome {
  searches: number;
  rec: SearchCallRecord;
  filtered: CandidateFilterResult;
  fetched: number;
  skipped: number;
  selfReported: number;
  unverified: number;
}

/**
 * One Luna web_search call → budget (from events) → search_log → filterSelections (event / instruction URLs
 * only) → candidates → the fetcher. Shared by the main call and the supplement calls (single fetch path).
 */
async function searchCall(
  ctx: StageContext,
  a: {
    task: string;
    callId: string;
    prompt: string;
    cap: number;
    instr: { url: string; note: string }[];
    warnings: string[];
    outputs: Set<string>;
    logExtra?: { supplement: true; aspect: string };
    /** drop candidates whose URL already has a fetch decision / card in this work before fetching */
    skipKnown?: boolean;
    maxSelections?: number;
  },
): Promise<CallOutcome> {
  const { task, warnings, outputs } = a;
  const budget = ctx.budget;
  const at = isoLocal(ctx.now());
  const res = await ctx.luna.call({ task, prompt: a.prompt, schema: SEARCH_SCHEMA, tools: "web_search", jobId: ctx.jobId, timeoutMs: SEARCH_TIMEOUT_MS });
  const out = (res.output ?? { selections: [], notes: null }) as SearchOutput;
  const events = res.toolEvents?.webSearch ?? [];
  if (res.toolEvents && res.toolEvents.otherToolItems > 0) {
    warnings.push(`${task}: unexpected tool items ${res.toolEvents.otherToolTypes.join(",")} (${res.toolEvents.otherToolItems})`);
  }

  // Budget: searches are counted from events, not from what the model says (§1.3-1).
  const searches = events.filter((e) => e.action === "search").length;
  budget.searchesUsed += searches;
  if (searches > a.cap) warnings.push(`${task}: ${searches} searches exceeded the cap ${a.cap} (advisory)`);
  writeBudget(ctx.workDir, budget);
  outputs.add(RESEARCH_FILES.budget);

  const rec = recordSearchCall(a.callId, task, at, events, []);
  appendSearchLog(ctx.workDir, [a.logExtra ? ({ ...rec, ...a.logExtra } satisfies SupplementSearchRecord) : rec]);
  outputs.add(RESEARCH_FILES.searchLog);

  let selections: ModelSelection[] = (out.selections ?? []).map((s) => ({
    url: s.url,
    why: s.why,
    aspects: s.aspects,
    tier_suggested: s.tier_suggested,
  }));
  const maxSel = a.maxSelections ?? MAX_SELECTIONS;
  if (selections.length > maxSel) {
    warnings.push(`${task}: ${selections.length} selections returned, kept the first ${maxSel}`);
    selections = selections.slice(0, maxSel);
  }
  // Instruction URLs are candidates by themselves (§1.3-1), even if Luna did not pick them.
  // They go FIRST so that a tight fetch budget never drops what the requester named (CP-019).
  const instr = a.instr;
  const instrKeys = new Set(instr.map((i) => urlMatchKey(i.url)));
  const lunaPicked = new Map(selections.map((s) => [urlMatchKey(s.url), s] as const));
  selections = [
    ...instr.map((i) => lunaPicked.get(urlMatchKey(i.url)) ?? { url: i.url, why: `instruction: ${i.note}` }),
    ...selections.filter((s) => !instrKeys.has(urlMatchKey(s.url))),
  ];

  const filtered = filterSelections(selections, rec, at, instr);
  appendCandidates(ctx.workDir, { selected: filtered.selected, rejected: filtered.rejected });
  appendGaps(ctx.workDir, filtered.gaps);
  outputs.add(RESEARCH_FILES.candidates);
  outputs.add(RESEARCH_FILES.gaps);
  const selfReported = filtered.rejected.filter((r) => r.reason === "self_reported").length;
  if (selfReported) warnings.push(`${task}: ${selfReported} self-reported URL(s) rejected (§1.3-1)`);
  const unverified = filtered.gaps.filter((g) => g.kind === "unverified_open_page").length;
  if (unverified) warnings.push(`${task}: ${unverified} open_page event(s) on URLs the harness did not pass (advisory, §1.3-4)`);

  let toFetch = filtered.selected;
  if (a.skipKnown) {
    const knownKeys = new Set<string>();
    for (const c of readSources(ctx.workDir)) for (const u of [c.url, c.final_url]) if (typeof u === "string") knownKeys.add(urlMatchKey(u) ?? "");
    for (const d of readFetchLog(ctx.workDir)) knownKeys.add(urlMatchKey(d.url) ?? "");
    toFetch = toFetch.filter((c) => !knownKeys.has(urlMatchKey(c.url) ?? ""));
  }
  let fetched = 0;
  let skipped = 0;
  if (toFetch.length) {
    const existing = readSources(ctx.workDir);
    const fr = await ctx.fetcher.fetchAll(toFetch, { workDir: ctx.workDir, budget, existing, now: ctx.now, jobId: ctx.jobId });
    appendSources(ctx.workDir, fr.cards);
    appendFetchLog(ctx.workDir, fr.decisions);
    appendGaps(ctx.workDir, fr.gaps);
    writeBudget(ctx.workDir, budget);
    outputs.add(RESEARCH_FILES.sources);
    outputs.add(RESEARCH_FILES.fetchLog);
    fetched = fr.cards.length;
    skipped = fr.decisions.filter((d) => d.decision !== "fetched").length;
    if (skipped) warnings.push(`${task}: ${skipped} candidate(s) not fetched (see fetch_log.json / gaps.json)`);
  } else if (!filtered.selected.length) {
    warnings.push(`${task}: no usable candidates`);
  }
  return { searches, rec, filtered, fetched, skipped, selfReported, unverified };
}

export async function runSearch(ctx: StageContext, opts: RunSearchOptions): Promise<StageResult> {
  const task = `s1.search.r${opts.round}`;
  const outputs = new Set<string>();
  const warnings: string[] = [];
  const nowIso = () => isoLocal(ctx.now());
  const budget = ctx.budget;

  const left = Math.max(0, budget.limits.searches - budget.searchesUsed);
  if (left <= 0) {
    const gap: ResearchGap = {
      kind: "budget_exhausted",
      detail: `search budget exhausted (${budget.searchesUsed}/${budget.limits.searches}); ${task} skipped for aspects: ${opts.aspects.join(", ")}`,
      at: nowIso(),
    };
    appendGaps(ctx.workDir, [gap]);
    writeBudget(ctx.workDir, budget);
    ctx.log(`${task}: search budget exhausted, no call`);
    return {
      outputs: [RESEARCH_FILES.gaps, RESEARCH_FILES.budget],
      metrics: { searches: 0, results: 0, selected: 0, rejected_self_reported: 0, fetched: 0, skipped: 0, budget_exhausted: 1 },
      warnings: [gap.detail],
    };
  }
  const cap = Math.min(opts.maxSearches ?? DEFAULT_MAX_SEARCHES, left);

  const prompt = buildSearchPrompt({
    work: opts.work,
    aspects: opts.aspects,
    maxSearches: cap,
    round: opts.round,
    hints: opts.hints,
    instructionUrls: opts.instructionUrls,
    avoidUrls: [...new Set([...readSources(ctx.workDir).map((c) => c.url), ...readFetchLog(ctx.workDir).map((d) => d.url)])],
  });
  const main = await searchCall(ctx, {
    task,
    callId: `${ctx.jobId}:${task}:${ctx.now().getTime().toString(36)}`,
    prompt,
    cap,
    instr: opts.instructionUrls ?? [],
    warnings,
    outputs,
  });

  const supp = await runSupplement(ctx, opts, main.searches, warnings, outputs);

  const searches = main.searches + supp.searches;
  ctx.log(
    `${task}: searches=${searches} (main ${main.searches}, supplement ${supp.searches} in ${supp.calls} call(s)) results=${main.rec.results.length + supp.results} selected=${main.filtered.selected.length + supp.selected} fetched=${main.fetched + supp.fetched} uncovered=${supp.uncoveredBefore}->${supp.uncoveredAfter}`,
  );
  return {
    outputs: [...outputs],
    metrics: {
      searches,
      searches_main: main.searches,
      search_cap: cap,
      results: main.rec.results.length + supp.results,
      selected: main.filtered.selected.length + supp.selected,
      rejected: main.filtered.rejected.length + supp.rejected,
      rejected_self_reported: main.selfReported + supp.selfReported,
      unverified_open_pages: main.unverified + supp.unverified,
      fetched: main.fetched + supp.fetched,
      skipped: main.skipped + supp.skipped,
      supplement_enabled: supp.enabled ? 1 : 0,
      supplement_calls: supp.calls,
      supplement_failed_calls: supp.failed,
      supplement_searches: supp.searches,
      supplement_fetched: supp.fetched,
      aspects_uncovered_before: supp.uncoveredBefore,
      aspects_uncovered_after: supp.uncoveredAfter,
      aspects_uncovered_list: supp.uncoveredAfterList.join(","),
    },
    warnings,
  };
}

interface SupplementOutcome {
  enabled: boolean;
  calls: number;
  failed: number;
  searches: number;
  results: number;
  selected: number;
  rejected: number;
  selfReported: number;
  unverified: number;
  fetched: number;
  skipped: number;
  uncoveredBefore: number;
  uncoveredAfter: number;
  uncoveredAfterList: string[];
}

async function runSupplement(ctx: StageContext, opts: RunSearchOptions, searchesMain: number, warnings: string[], outputs: Set<string>): Promise<SupplementOutcome> {
  const so = opts.supplement === false ? { enabled: false } : (opts.supplement ?? {});
  const enabled = so.enabled ?? opts.round === 1;
  const o = {
    minSearches: so.minSearches ?? SUPPLEMENT_MIN_SEARCHES,
    maxCalls: so.maxCalls ?? SUPPLEMENT_MAX_CALLS,
    searchesPerCall: so.searchesPerCall ?? SUPPLEMENT_SEARCHES_PER_CALL,
    reserveSearches: so.reserveSearches ?? SUPPLEMENT_RESERVE_SEARCHES,
  };
  const outc: SupplementOutcome = { enabled, calls: 0, failed: 0, searches: 0, results: 0, selected: 0, rejected: 0, selfReported: 0, unverified: 0, fetched: 0, skipped: 0, uncoveredBefore: 0, uncoveredAfter: 0, uncoveredAfterList: [] };
  const uncoveredNow = () => [...aspectCoverage(ctx.workDir, opts.aspects).entries()].filter(([, n]) => n === 0).map(([a]) => a);
  const before = aspectCoverage(ctx.workDir, opts.aspects);
  const { targets, uncovered } = supplementTargets(before, searchesMain, o);
  outc.uncoveredBefore = uncovered.length;
  if (!enabled || !targets.length) {
    outc.uncoveredAfterList = uncovered;
    outc.uncoveredAfter = uncovered.length;
    return outc;
  }
  const task = `s1.search.r${opts.round}.supplement`;
  const budget = ctx.budget;
  const skippedForBudget: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const aspect = targets[i];
    const available = budget.limits.searches - budget.searchesUsed - o.reserveSearches;
    if (available <= 0) {
      skippedForBudget.push(...targets.slice(i));
      break;
    }
    const cap = Math.min(o.searchesPerCall, available);
    try {
      const prompt = buildSupplementPrompt({
        work: opts.work,
        aspect,
        aspectGuide: guideLine(aspect),
        maxSearches: cap,
        round: opts.round,
        avoidUrls: [...new Set([...readSources(ctx.workDir).map((c) => c.url), ...readFetchLog(ctx.workDir).map((d) => d.url)])],
      });
      outc.calls++;
      const r = await searchCall(ctx, {
        task,
        callId: `${ctx.jobId}:${task}:${i + 1}:${ctx.now().getTime().toString(36)}`,
        prompt,
        cap,
        instr: [],
        warnings,
        outputs,
        logExtra: { supplement: true, aspect },
        skipKnown: true,
        maxSelections: SUPPLEMENT_MAX_SELECTIONS,
      });
      outc.searches += r.searches;
      outc.results += r.rec.results.length;
      outc.selected += r.filtered.selected.length;
      outc.rejected += r.filtered.rejected.length;
      outc.selfReported += r.selfReported;
      outc.unverified += r.unverified;
      outc.fetched += r.fetched;
      outc.skipped += r.skipped;
    } catch (e) {
      outc.failed++;
      warnings.push(`${task} [${aspect}]: supplement call failed (continuing): ${(e as Error).message.slice(0, 300)}`);
    }
  }
  if (skippedForBudget.length) {
    const gap: ResearchGap = {
      kind: "budget_exhausted",
      detail: `search supplement skipped (budget ${budget.searchesUsed}/${budget.limits.searches}, reserve ${o.reserveSearches} for later rounds) for aspects: ${skippedForBudget.join(", ")}`,
      at: isoLocal(ctx.now()),
    };
    appendGaps(ctx.workDir, [gap]);
    outputs.add(RESEARCH_FILES.gaps);
    warnings.push(gap.detail);
  }
  outc.uncoveredAfterList = uncoveredNow();
  outc.uncoveredAfter = outc.uncoveredAfterList.length;
  if (outc.uncoveredAfter) warnings.push(`${task}: aspects still without a source after the supplement: ${outc.uncoveredAfterList.join(", ")} (follow-up / gaps handle them)`);
  return outc;
}

/**
 * M1 gate helper (§1.3-1/2): every source card must trace back to a web_search result URL recorded in
 * search_log.json (with a matching call id), or to an instruction URL. Returns violations (empty = OK).
 * Instruction-origin cards are checked against `instructionUrls` when given, otherwise against the
 * instruction-origin candidates recorded in candidates.json.
 */
export function assertCardsTraceable(workDir: string, instructionUrls?: string[]): string[] {
  const cards = readSources(workDir);
  const log = readSearchLog(workDir);
  const resultKeys = new Set<string>();
  const byCall = new Map<string, Set<string>>();
  for (const rec of log) {
    const set = byCall.get(rec.call_id) ?? new Set<string>();
    for (const r of rec.results) {
      const k = urlMatchKey(r.url);
      if (!k) continue;
      resultKeys.add(k);
      set.add(k);
    }
    byCall.set(rec.call_id, set);
  }
  const instrKeys = new Set<string>();
  if (instructionUrls) {
    for (const u of instructionUrls) {
      const k = urlMatchKey(u);
      if (k) instrKeys.add(k);
    }
  } else {
    for (const c of readCandidates(workDir).selected) {
      if (c.origin.kind !== "instruction") continue;
      const k = urlMatchKey(c.url);
      if (k) instrKeys.add(k);
    }
  }
  const violations: string[] = [];
  for (const card of cards) {
    const k = urlMatchKey(card.url);
    if (!k) {
      violations.push(`${card.source_id}: invalid url ${card.url}`);
      continue;
    }
    if (card.origin?.kind === "search_event") {
      const callSet = byCall.get(card.origin.callId);
      if (!callSet) violations.push(`${card.source_id}: origin call ${card.origin.callId} not in search_log.json`);
      else if (!callSet.has(k)) violations.push(`${card.source_id}: ${card.url} not among results of call ${card.origin.callId}`);
    } else if (card.origin?.kind === "instruction") {
      if (!instrKeys.has(k)) violations.push(`${card.source_id}: ${card.url} has instruction origin but is not an instruction URL`);
    } else if (!resultKeys.has(k)) {
      violations.push(`${card.source_id}: ${card.url} has no origin and is not in search_log.json results`);
    }
  }
  return violations;
}
