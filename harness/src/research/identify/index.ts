/**
 * S0 identification (WP-1.6, REQUIREMENTS §4.6): lookup key → INDEX match → (none) small identification research
 * (search ≤5, fetch ≤8, counted into the job budget) → Luna extracts candidates → code verifies and decides
 * → work.json / INDEX.json / aliases.
 *
 * The model never decides: candidate URLs come only from web_search events (filterSelections), only the fetcher
 * creates source cards, evidence quotes are verified verbatim against saved text, and the resolution /
 * confirmed-vs-provisional rules are deterministic code (C-7, §1.3).
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../../model/callLog.ts";
import type { ModelPort } from "../../model/types.ts";
import { filterSelections, recordSearchCall, type SearchCallRecord } from "../candidates.ts";
import { normKey } from "../textMatch.ts";
import { IDENTIFY_BUDGET, type BudgetState, type Candidate, type FetchDecision, type Fetcher, type ResearchGap, type SourceCard } from "../types.ts";
import type { WebSearchEvent } from "../../model/types.ts";
import { addAlias, hasAlias } from "../../works/aliases.ts";
import { makeWorkId } from "../../works/slug.ts";
import { readIndex, readJsonOr, readWork, rebuildIndex, STAGING_PREFIX, writeJsonAtomic, writeWork } from "../../works/store.ts";
import type { IndexEntry, Work, WorksIndex } from "../../works/types.ts";
import {
  applyMediumHint,
  attestingSources,
  decideTitleStatus,
  groupCandidates,
  loadSource,
  normalizeMediumHint,
  readingBasis,
  verifyCandidates,
  type LoadedSource,
  type VerifiedCandidate,
} from "./decide.ts";
import { matchIndex, normalizeQuery } from "./normalize.ts";
import { buildExtractPrompt, buildSearchPrompt, EXTRACT_SCHEMA, SEARCH_SCHEMA, type ExtractOutput, type SearchOutput } from "./prompts.ts";
import { renameSyncRetry } from "../../util/fsRetry.ts";

export { matchIndex, normalizeQuery } from "./normalize.ts";

/** Chars of each fetched text handed to the extraction call. */
export const EXTRACT_TEXT_CHARS = 6000;

export interface IdentifyInput {
  jobId: string;
  /** Input as typed (never rewritten). */
  workQuery: string;
  mediumHint: string | null;
  /** AMENDMENT 16: 「N作目」 — resolve the Nth series entry as the work (null = the named work itself). */
  installment?: number | null;
}

export interface IdentifyDeps {
  luna: ModelPort;
  fetcher: Fetcher;
  /** Absolute path of works/. */
  worksDir: string;
  /** Shared job budget (mutated: identification usage is counted in). */
  budget: BudgetState;
  now: () => Date;
  log: (m: string) => void;
  /** Tests only (passed through to the fetcher). */
  allowPrivateAddresses?: boolean;
}

/** §4.1 JobRequest.resolved */
export interface ResolvedRef {
  work_id: string;
  title: string;
  title_status: "confirmed" | "provisional";
  method: "index_match" | "research";
  source_ids: string[];
  alias_recorded: boolean;
  resolved_at: string;
}

export interface IdentifyCandidate {
  title: string;
  medium: string;
  first_release_year: number | null;
  /** Set for candidates that are existing works (index matches). */
  work_id: string | null;
  creators: string[];
}

export type ClarifyReason = "multiple_index_matches" | "multiple_candidates" | "no_candidates" | "no_reading";

export interface IdentifyResult {
  status: "resolved" | "clarifying";
  reason?: ClarifyReason;
  resolved?: ResolvedRef;
  candidates?: IdentifyCandidate[];
  /** works/<work_id>/ when resolved; the staging dir when clarifying after research. */
  workDir?: string;
  /** §4.6-5 notification text when the input differs from the canonical title. */
  notice?: string;
  metrics: Record<string, number | string>;
}

export async function identify(input: IdentifyInput, deps: IdentifyDeps): Promise<IdentifyResult> {
  const at = () => isoLocal(deps.now());
  const key = normalizeQuery(input.workQuery);
  const hint = normalizeMediumHint(input.mediumHint);
  fs.mkdirSync(deps.worksDir, { recursive: true });

  // a. INDEX match (no model call)
  const index = readIndex(deps.worksDir);
  // AMENDMENT 16: an installment selector (「N作目」) names a different work than the one the query
  // literally matches — the index shortcut must not resolve it to the base work (job 20261124-0006
  // resolved 「マトリックス 2作目」 to the first film). Identification research decides instead.
  let matches = input.installment != null ? [] : matchIndex(key, index);
  if (input.installment != null) deps.log(`S0: installment ${input.installment} requested — index shortcut skipped`);
  if (hint && matches.length > 0) {
    const byId = new Map(index.works.map((e) => [e.work_id, e]));
    const narrowed = matches.filter((id) => normalizeMediumHint(byId.get(id)?.medium ?? null) === hint);
    if (narrowed.length < matches.length) deps.log(`S0: medium_hint=${hint} narrows index matches ${matches.length} → ${narrowed.length}`);
    matches = narrowed;
  }
  if (matches.length === 1) return resolveFromIndex(matches[0], input, key, deps, at);
  if (matches.length > 1) {
    deps.log(`S0: "${key}" matches ${matches.length} works in INDEX → clarifying`);
    return {
      status: "clarifying",
      reason: "multiple_index_matches",
      candidates: matches.map((id) => {
        const w = readWork(path.join(deps.worksDir, id));
        return { title: w.title, medium: w.medium, first_release_year: w.first_release_year, work_id: id, creators: w.creators };
      }),
      metrics: { method: "index_match", index_matches: matches.length, model_calls: 0, searches_used: 0, fetches_used: 0 },
    };
  }

  // b–f. identification research
  return research(input, key, hint, index, deps, at);
}

// ---------------------------------------------------------------- index path

function resolveFromIndex(workId: string, input: IdentifyInput, key: string, deps: Pick<IdentifyDeps, "worksDir" | "log">, at: () => string): IdentifyResult {
  const workDir = path.join(deps.worksDir, workId);
  const work = readWork(workDir);
  const sources = loadWorkSources(workDir);
  const outcome = recordInputAlias(work, key, sources, input.jobId, at());
  if (outcome === "added" || outcome === "merged") {
    work.history.push({ at: at(), event: "alias_added", job_id: input.jobId, detail: `input alias "${key}" (${outcome})` });
    writeWork(workDir, work);
  }
  rebuildIndex(deps.worksDir);
  deps.log(`S0: "${key}" → ${workId} by index_match (alias ${outcome})`);
  return {
    status: "resolved",
    resolved: {
      work_id: workId,
      title: work.title,
      title_status: work.title_status,
      method: "index_match",
      source_ids: [...work.title_source_ids],
      alias_recorded: hasAlias(work, key),
      resolved_at: at(),
    },
    workDir,
    notice: noticeFor(input.workQuery, key, work.title),
    metrics: { method: "index_match", index_matches: 1, model_calls: 0, searches_used: 0, fetches_used: 0, alias: outcome },
  };
}

// ---------------------------------------------------------------- research path

interface CandidatesFile {
  selected: Candidate[];
  rejected: { url: string; reason: string; why?: string }[];
}

async function research(
  input: IdentifyInput,
  key: string,
  hint: string | null,
  index: WorksIndex,
  deps: IdentifyDeps,
  at: () => string,
): Promise<IdentifyResult> {
  const { luna, fetcher, budget, log } = deps;
  const staging = path.join(deps.worksDir, `${STAGING_PREFIX}${input.jobId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  const researchDir = path.join(staging, "research");
  fs.mkdirSync(path.join(researchDir, "raw"), { recursive: true });

  const gaps: ResearchGap[] = [];
  const searchLog: SearchCallRecord[] = [];
  const candidatesFile: CandidatesFile = { selected: [], rejected: [] };
  let modelCalls = 0;
  let searchesObserved = 0;
  let searchesUsed = 0;

  // b-1. one luna search call
  const searchCap = Math.max(0, Math.min(IDENTIFY_BUDGET.searches, budget.limits.searches - budget.searchesUsed));
  if (searchCap === 0) {
    gaps.push({ kind: "budget_exhausted", detail: "S0 identification: no search budget left; search skipped", at: at() });
    log("S0: search budget exhausted, skipping identification search");
  } else {
    const res = await luna.call({
      task: "s0.identify.search",
      prompt: buildSearchPrompt(input.workQuery, input.mediumHint, searchCap, IDENTIFY_BUDGET.fetches, input.installment ?? null),
      schema: SEARCH_SCHEMA,
      tools: "web_search",
      jobId: input.jobId,
    });
    modelCalls++;
    const capped = capSearchEvents(res.toolEvents?.webSearch ?? [], searchCap);
    searchesObserved = capped.observed;
    searchesUsed = Math.min(capped.observed, searchCap);
    budget.searchesUsed += searchesUsed;
    if (capped.observed > searchCap) {
      gaps.push({
        kind: "budget_exhausted",
        detail: `S0 identification: ${capped.observed} searches observed, cap ${searchCap}; results of searches beyond the cap were ignored`,
        at: at(),
      });
    }
    const rec = recordSearchCall(`${input.jobId}-s0-search-1`, "s0.identify.search", at(), capped.events);
    searchLog.push(rec);
    const out = res.output as SearchOutput;
    const filtered = filterSelections(
      (out.selections ?? []).map((s) => ({ url: s.url, why: s.why, aspects: ["bibliographic", "title"], tier_suggested: s.tier_suggested })),
      rec,
      at(),
    );
    gaps.push(...filtered.gaps);
    candidatesFile.rejected.push(...filtered.rejected);
    candidatesFile.selected = filtered.selected.slice(0, IDENTIFY_BUDGET.fetches);
    for (const extra of filtered.selected.slice(IDENTIFY_BUDGET.fetches)) {
      candidatesFile.rejected.push({ url: extra.url, reason: "over_identify_selection_cap", why: extra.why });
    }
    log(`S0: search used ${searchesUsed} (observed ${searchesObserved}), selected ${candidatesFile.selected.length}, rejected ${candidatesFile.rejected.length}`);
  }

  // b-2. fetch (≤8 for identification AND within the job budget)
  let cards: SourceCard[] = [];
  let decisions: FetchDecision[] = [];
  const fetchStart = budget.fetchesUsed;
  if (candidatesFile.selected.length > 0) {
    const view: BudgetState = {
      limits: { ...budget.limits, fetches: Math.min(budget.limits.fetches, budget.fetchesUsed + IDENTIFY_BUDGET.fetches) },
      searchesUsed: budget.searchesUsed,
      fetchesUsed: budget.fetchesUsed,
      startedAt: budget.startedAt,
    };
    const fr = await fetcher.fetchAll(candidatesFile.selected, {
      workDir: staging,
      budget: view,
      existing: [],
      now: deps.now,
      allowPrivateAddresses: deps.allowPrivateAddresses,
      jobId: input.jobId,
    });
    budget.fetchesUsed += Math.max(0, view.fetchesUsed - fetchStart);
    cards = fr.cards;
    decisions = fr.decisions;
    gaps.push(...fr.gaps);
  }
  const fetchesUsed = budget.fetchesUsed - fetchStart;
  log(`S0: fetched ${cards.length} cards (fetches used ${fetchesUsed})`);

  writeJsonAtomic(path.join(researchDir, "search_log.json"), searchLog);
  writeJsonAtomic(path.join(researchDir, "candidates.json"), candidatesFile);
  writeJsonAtomic(path.join(researchDir, "fetch_log.json"), decisions);
  writeJsonAtomic(path.join(researchDir, "sources.json"), cards);
  writeJsonAtomic(path.join(researchDir, "gaps.json"), gaps);
  writeJsonAtomic(path.join(researchDir, "budget.json"), budget);

  const metrics: Record<string, number | string> = {
    method: "research",
    searches_used: searchesUsed,
    searches_observed: searchesObserved,
    fetches_used: fetchesUsed,
    selected: candidatesFile.selected.length,
    self_reported_rejected: candidatesFile.rejected.filter((r) => r.reason === "self_reported").length,
    cards: cards.length,
  };

  // c. extraction (tools: none) over saved texts
  const loaded = new Map<string, LoadedSource>();
  for (const c of cards) {
    const t = readRaw(staging, c);
    if (t !== null) loaded.set(c.source_id, loadSource(c, t));
  }
  const trace: Record<string, unknown> = { job_id: input.jobId, at: at(), work_query: input.workQuery, key, medium_hint: input.mediumHint, installment: input.installment ?? null };
  const traceFile = path.join(researchDir, `identify_${input.jobId}.json`);

  let verified: VerifiedCandidate[] = [];
  if (loaded.size > 0) {
    const prompt = buildExtractPrompt(
      input.workQuery,
      input.mediumHint,
      [...loaded.values()].map((s) => ({
        source_id: s.card.source_id,
        tier: s.card.tier,
        site_key: s.card.site_key,
        title: s.card.title,
        url: s.card.final_url || s.card.url,
        text: s.text.orig.slice(0, EXTRACT_TEXT_CHARS),
      })),
      input.installment ?? null,
    );
    const res = await luna.call({ task: "s0.identify.extract", prompt, schema: EXTRACT_SCHEMA, tools: "none", jobId: input.jobId });
    modelCalls++;
    const out = res.output as ExtractOutput;
    // d. code decides
    const v = verifyCandidates(out.candidates ?? [], loaded);
    verified = groupCandidates(v.kept);
    metrics.candidates_extracted = (out.candidates ?? []).length;
    metrics.evidence_total = v.evidenceTotal;
    metrics.evidence_dropped = v.evidenceDropped;
    metrics.aliases_dropped = v.aliasesDropped;
    metrics.candidates_dropped = v.dropped.length;
    trace.extracted = (out.candidates ?? []).map((c) => ({ title: c.title, medium: c.medium, first_release_year: c.first_release_year, evidence_items: c.evidence.length }));
    trace.dropped = v.dropped;
  }
  metrics.model_calls = modelCalls;
  const hinted = applyMediumHint(verified, hint);
  metrics.candidates_verified = verified.length;
  metrics.medium_hint_applied = hinted.applied ? "yes" : "no";
  trace.verified = verified.map(traceCandidate);
  trace.medium_hint_applied = hinted.applied;
  const finalists = hinted.list;

  const clarify = (reason: ClarifyReason, list: VerifiedCandidate[]): IdentifyResult => {
    trace.decision = { status: "clarifying", reason };
    writeJsonAtomic(traceFile, trace);
    log(`S0: clarifying (${reason}), ${list.length} candidates`);
    return {
      status: "clarifying",
      reason,
      candidates: list.map((c) => ({ title: c.title, medium: c.medium, first_release_year: c.first_release_year, work_id: null, creators: c.creators })),
      workDir: staging,
      metrics,
    };
  };
  trace.finalists = finalists.map(traceCandidate);
  if (finalists.length === 0) return clarify("no_candidates", []);
  if (finalists.length > 1) return clarify("multiple_candidates", finalists);
  return resolveCandidate({ input, key, index, staging, cards, loaded, trace, traceFile, metrics, finalists, cand: finalists[0], clarify, deps, at });
}

interface ResolveContext {
  input: IdentifyInput;
  key: string;
  index: WorksIndex;
  staging: string;
  cards: SourceCard[];
  loaded: Map<string, LoadedSource>;
  trace: Record<string, unknown>;
  traceFile: string;
  metrics: Record<string, number | string>;
  finalists: VerifiedCandidate[];
  cand: VerifiedCandidate;
  clarify: (reason: ClarifyReason, list: VerifiedCandidate[]) => IdentifyResult;
  deps: Pick<IdentifyDeps, "worksDir" | "log">;
  at: () => string;
}

/**
 * e. resolution of ONE verified candidate whose sources sit in the staging dir (research path tail; also used by
 * finalizeStagedCandidate when the requester picks a candidate after clarifying — no new search, §4.1).
 */
function resolveCandidate(r: ResolveContext): IdentifyResult {
  const { input, key, index, staging, cards, loaded, trace, traceFile, metrics, finalists, cand, clarify, deps, at } = r;
  const { log } = deps;
  const cardMap = new Map(cards.map((c) => [c.source_id, c]));
  const titleStatus = decideTitleStatus(cand.evidence, cardMap);
  const evidenceIds = [...new Set(cand.evidence.map((e) => e.source_id))].sort();
  const basis = readingBasis(cand.title_reading, loaded.values());

  let workId = findExistingWork(index, cand);
  if (!workId) {
    if (!cand.title_reading) return clarify("no_reading", finalists);
    try {
      workId = makeWorkId(cand.medium, cand.title_reading, cand.first_release_year);
    } catch (e) {
      log(`S0: cannot build work_id from reading "${cand.title_reading}": ${(e as Error).message}`);
      return clarify("no_reading", finalists);
    }
  }

  // e. resolution
  trace.decision = { status: "resolved", work_id: workId, title: cand.title, title_status: titleStatus, evidence_source_ids: evidenceIds, reading_basis: basis };
  writeJsonAtomic(traceFile, trace);
  const target = path.join(deps.worksDir, workId);
  const existed = fs.existsSync(path.join(target, "work.json"));
  if (fs.existsSync(target)) mergeStaging(staging, target);
  else renameSyncRetry(staging, target);

  const allSources = loadWorkSources(target);
  const allCards = new Map([...allSources.values()].map((s) => [s.card.source_id, s.card]));
  for (const c of readJsonOr<SourceCard[]>(path.join(target, "research", "sources.json"), [])) if (!allCards.has(c.source_id)) allCards.set(c.source_id, c);
  const now = at();
  let work: Work;
  if (existed) {
    work = readWork(target);
    mergeWorkFields(work, cand, titleStatus, evidenceIds, basis, allCards, input.jobId, now);
  } else {
    work = {
      work_id: workId,
      title: cand.title,
      title_original: cand.title_original,
      title_reading: cand.title_reading,
      title_reading_basis: basis,
      title_status: titleStatus,
      title_source_ids: evidenceIds,
      aliases: [],
      medium: cand.medium,
      creators: cand.creators,
      genres: [],
      tags: [],
      first_release_year: cand.first_release_year,
      publish_mode: "Public",
      history: [{ at: now, event: "created", job_id: input.jobId, detail: `identification research (title_status ${titleStatus})` }],
      first_published_at: null,
      updated_at: null,
      created_at: now,
    };
  }
  for (const a of cand.aliases) {
    addAlias(work, { text: a.text, kind: a.kind, attested: true, source_ids: a.source_ids, origin_job_id: input.jobId, first_seen: now });
  }
  const aliasOutcome = recordInputAlias(work, key, [...allSources.values()], input.jobId, now);
  writeWork(target, work);
  rebuildIndex(deps.worksDir);
  metrics.alias = aliasOutcome;
  metrics.merged = existed ? "yes" : "no";
  log(`S0: "${key}" → ${workId} (${existed ? "merged into existing work" : "new work"}, title "${work.title}", ${work.title_status})`);

  return {
    status: "resolved",
    resolved: {
      work_id: workId,
      title: work.title,
      title_status: work.title_status,
      method: "research",
      source_ids: [...work.title_source_ids],
      alias_recorded: hasAlias(work, key),
      resolved_at: at(),
    },
    workDir: target,
    notice: noticeFor(input.workQuery, key, work.title),
    metrics,
  };
}

/**
 * WP-4.3: the requester picked candidate `pick` (1-based, in the order of the clarifying result) of a research-path
 * clarification. Re-reads the verified candidates and saved sources from works/_staging-<job_id>/ (the trace file
 * identify_<job_id>.json written by research()) and resolves exactly that candidate — no model call, no search,
 * no fetch. Returns clarifying again when the staged data is gone or the candidate has no usable reading.
 */
export function finalizeStagedCandidate(
  args: { jobId: string; pick: number },
  deps: Pick<IdentifyDeps, "worksDir" | "now" | "log">,
): IdentifyResult {
  const at = () => isoLocal(deps.now());
  const staging = path.join(deps.worksDir, `${STAGING_PREFIX}${args.jobId}`);
  const researchDir = path.join(staging, "research");
  const traceFile = path.join(researchDir, `identify_${args.jobId}.json`);
  const trace = readJsonOr<Record<string, unknown> | null>(traceFile, null);
  const metrics: Record<string, number | string> = { method: "research", model_calls: 0, searches_used: 0, fetches_used: 0, picked: args.pick };
  if (!trace) throw new Error(`no staged identification for job ${args.jobId} (${traceFile} missing); answer with a new work name instead`);
  const input: IdentifyInput = { jobId: args.jobId, workQuery: String(trace.work_query ?? ""), mediumHint: (trace.medium_hint as string | null) ?? null, installment: (trace.installment as number | null) ?? null };
  const key = normalizeQuery(input.workQuery);
  type Traced = ReturnType<typeof traceCandidate>;
  const tracedList: Traced[] =
    (trace.finalists as Traced[] | undefined) ?? applyMediumHint((trace.verified as Traced[] | undefined) ?? [], normalizeMediumHint(input.mediumHint)).list;
  const finalists: VerifiedCandidate[] = tracedList.map((c) => ({
    title: c.title,
    title_original: c.title_original ?? null,
    title_reading: c.title_reading,
    medium: c.medium,
    creators: c.creators ?? [],
    first_release_year: c.first_release_year,
    evidence: c.evidence ?? [],
    aliases: c.aliases ?? [],
  }));
  const cand = finalists[args.pick - 1];
  if (!cand) throw new Error(`candidate ${args.pick} does not exist (1..${finalists.length})`);
  const cards = readJsonOr<SourceCard[]>(path.join(researchDir, "sources.json"), []);
  const loaded = new Map<string, LoadedSource>();
  for (const c of cards) {
    const t = readRaw(staging, c);
    if (t !== null) loaded.set(c.source_id, loadSource(c, t));
  }
  trace.picked = { at: at(), pick: args.pick, title: cand.title, medium: cand.medium, first_release_year: cand.first_release_year };
  const clarify = (reason: ClarifyReason, list: VerifiedCandidate[]): IdentifyResult => {
    trace.decision = { status: "clarifying", reason };
    writeJsonAtomic(traceFile, trace);
    deps.log(`S0: picked candidate ${args.pick} cannot be resolved (${reason})`);
    return {
      status: "clarifying",
      reason,
      candidates: list.map((c) => ({ title: c.title, medium: c.medium, first_release_year: c.first_release_year, work_id: null, creators: c.creators })),
      workDir: staging,
      metrics,
    };
  };
  deps.log(`S0: requester picked candidate ${args.pick} "${cand.title}" (${cand.medium}, ${cand.first_release_year ?? "?"}) — resolving from staged sources, no new search`);
  return resolveCandidate({ input, key, index: readIndex(deps.worksDir), staging, cards, loaded, trace, traceFile, metrics, finalists, cand, clarify, deps, at });
}

/** WP-4.3: the requester picked an existing work (index candidate) — same as a single index match. */
export function resolvePickedWork(input: IdentifyInput, workId: string, deps: Pick<IdentifyDeps, "worksDir" | "now" | "log">): IdentifyResult {
  const at = () => isoLocal(deps.now());
  if (!fs.existsSync(path.join(deps.worksDir, workId, "work.json"))) throw new Error(`picked work ${workId} does not exist`);
  return resolveFromIndex(workId, input, normalizeQuery(input.workQuery), deps, at);
}

// ---------------------------------------------------------------- helpers

/** Keep all non-search events and only the first `cap` search events. */
export function capSearchEvents(events: WebSearchEvent[], cap: number): { events: WebSearchEvent[]; observed: number } {
  let n = 0;
  const kept: WebSearchEvent[] = [];
  for (const e of events) {
    if (e.action === "search") {
      n++;
      if (n > cap) continue;
    }
    kept.push(e);
  }
  return { events: kept, observed: n };
}

/** Same title (or a recorded alias / original title) + same medium + compatible year → that existing work. */
function findExistingWork(index: WorksIndex, c: VerifiedCandidate): string | null {
  const tKey = normKey(c.title);
  const hits = index.works.filter((e: IndexEntry) => {
    if (e.medium !== c.medium) return false;
    const names = [e.title, e.title_original, ...(e.aliases ?? []).map((a) => a.text)].filter((x): x is string => !!x);
    return names.some((n) => normKey(n) === tKey);
  });
  if (hits.length !== 1) return null;
  return hits[0].work_id;
}

function readRaw(workDir: string, card: SourceCard): string | null {
  const rel = card.raw_text_path || path.join("research", "raw", `${card.source_id}.txt`);
  try {
    return fs.readFileSync(path.join(workDir, rel), "utf8");
  } catch {
    return null;
  }
}

function loadWorkSources(workDir: string): LoadedSource[] {
  const cards = readJsonOr<SourceCard[]>(path.join(workDir, "research", "sources.json"), []);
  const out: LoadedSource[] = [];
  for (const c of cards) {
    const t = readRaw(workDir, c);
    if (t !== null) out.push(loadSource(c, t));
  }
  return out;
}

/** §4.6-6: record the input notation when it differs from the title; attested (→ common) if a saved source names it. */
function recordInputAlias(work: Work, key: string, sources: LoadedSource[], jobId: string, now: string) {
  if (normalizeQuery(key) === normalizeQuery(work.title)) return "skipped" as const;
  const att = attestingSources(key, work.title, sources);
  return addAlias(work, {
    text: key,
    kind: att.length > 0 ? "common" : "input",
    attested: att.length > 0,
    source_ids: att,
    origin_job_id: jobId,
    first_seen: now,
  });
}

function mergeWorkFields(
  work: Work,
  cand: VerifiedCandidate,
  newStatus: "confirmed" | "provisional",
  evidenceIds: string[],
  basis: "source" | "estimated",
  cards: Map<string, SourceCard>,
  jobId: string,
  now: string,
): void {
  const sameTitle = normKey(cand.title) === normKey(work.title);
  if (sameTitle) {
    const ids = [...new Set([...work.title_source_ids, ...evidenceIds])].sort();
    const recomputed = decideTitleStatus(ids.map((source_id) => ({ source_id, offset: 0, length: 0 })), cards);
    work.title_source_ids = ids;
    if (work.title_status === "provisional" && recomputed === "confirmed") {
      work.title_status = "confirmed";
      work.history.push({ at: now, event: "title_confirmed", job_id: jobId, detail: "new evidence meets the confirmed rule" });
    }
  } else if (work.title_status === "provisional" && newStatus === "confirmed") {
    // §4.6-8: the old title moves to aliases; work_id never changes.
    const old = work.title;
    const oldIds = work.title_source_ids;
    work.title = cand.title;
    work.title_status = "confirmed";
    work.title_source_ids = evidenceIds;
    addAlias(work, { text: old, kind: "common", attested: oldIds.length > 0, source_ids: oldIds, origin_job_id: jobId, first_seen: now });
    work.history.push({ at: now, event: "title_changed", job_id: jobId, detail: `"${old}" → "${cand.title}" (provisional → confirmed)` });
  } else {
    addAlias(work, { text: cand.title, kind: "common", attested: true, source_ids: evidenceIds, origin_job_id: jobId, first_seen: now });
  }
  work.title_original ??= cand.title_original;
  if (!work.title_reading && cand.title_reading) {
    work.title_reading = cand.title_reading;
    work.title_reading_basis = basis;
  } else if (work.title_reading_basis === "estimated" && basis === "source" && cand.title_reading && normKey(cand.title_reading) === normKey(work.title_reading ?? "")) {
    work.title_reading_basis = "source";
  }
  work.creators = [...new Set([...work.creators, ...cand.creators])];
  work.first_release_year ??= cand.first_release_year;
  work.history.push({ at: now, event: "merged", job_id: jobId, detail: `identification research merged (${evidenceIds.length} evidence sources)` });
}

/**
 * Move a staging dir's research into an existing work dir: cards dedup by source_id (raw files move with new cards),
 * logs are appended, budget.json is replaced by the current job's state, then the staging dir is removed.
 */
function mergeStaging(staging: string, target: string): void {
  const sR = path.join(staging, "research");
  const tR = path.join(target, "research");
  fs.mkdirSync(path.join(tR, "raw"), { recursive: true });

  const tCards = readJsonOr<SourceCard[]>(path.join(tR, "sources.json"), []);
  const sCards = readJsonOr<SourceCard[]>(path.join(sR, "sources.json"), []);
  const have = new Set(tCards.map((c) => c.source_id));
  const rawDir = path.join(sR, "raw");
  const rawFiles = fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : [];
  for (const c of sCards) {
    if (have.has(c.source_id)) continue;
    tCards.push(c);
    have.add(c.source_id);
    for (const f of rawFiles) {
      if (f === `${c.source_id}` || f.startsWith(`${c.source_id}.`)) fs.renameSync(path.join(rawDir, f), path.join(tR, "raw", f));
    }
  }
  writeJsonAtomic(path.join(tR, "sources.json"), tCards);

  for (const f of ["search_log.json", "fetch_log.json", "gaps.json"]) {
    const a = readJsonOr<unknown[]>(path.join(tR, f), []);
    const b = readJsonOr<unknown[]>(path.join(sR, f), []);
    writeJsonAtomic(path.join(tR, f), [...a, ...b]);
  }
  const ca = readJsonOr<CandidatesFile>(path.join(tR, "candidates.json"), { selected: [], rejected: [] });
  const cb = readJsonOr<CandidatesFile>(path.join(sR, "candidates.json"), { selected: [], rejected: [] });
  writeJsonAtomic(path.join(tR, "candidates.json"), { selected: [...ca.selected, ...cb.selected], rejected: [...ca.rejected, ...cb.rejected] });

  const handled = new Set(["sources.json", "search_log.json", "fetch_log.json", "gaps.json", "candidates.json", "raw"]);
  if (fs.existsSync(sR)) {
    for (const f of fs.readdirSync(sR)) {
      if (handled.has(f)) continue;
      const dst = path.join(tR, f);
      if (f === "budget.json" || !fs.existsSync(dst)) fs.copyFileSync(path.join(sR, f), dst);
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

function traceCandidate(c: VerifiedCandidate) {
  return {
    title: c.title,
    title_original: c.title_original,
    medium: c.medium,
    first_release_year: c.first_release_year,
    title_reading: c.title_reading,
    creators: c.creators,
    evidence: c.evidence,
    aliases: c.aliases,
  };
}

function noticeFor(raw: string, key: string, title: string): string | undefined {
  if (normalizeQuery(key) === normalizeQuery(title)) return undefined;
  return `入力「${raw}」→ 正式名称「${title}」`;
}
