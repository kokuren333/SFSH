import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import type { ModelPort } from "../model/types.ts";
import { assembleNkg, buildFactLayer, buildInterpLayer, buildPhases } from "../nkg/build.ts";
import { selectModules } from "../nkg/modules.ts";
import { validateNkgFile } from "../nkg/validate.ts";
import { reviewClaims } from "../research/claimReview.ts";
import { extractClaims } from "../research/claims.ts";
import { allowance, FRAMES, type FramePlan } from "../research/frames.ts";
import { runPlotSearch } from "../research/plotSearch.ts";
import { coverageFollowUp, gapFill, refact } from "../research/targeted.ts";
import { identify } from "../research/identify/index.ts";
import { readClaims, readGaps, readSources, readFetchLog, writeBudget } from "../research/researchIo.ts";
import { assertCardsTraceable, runSearch } from "../research/search.ts";
import { DEFAULT_BUDGET, type BudgetLimits, type BudgetState, type Fetcher } from "../research/types.ts";
import { readWork } from "../works/store.ts";
import { composePublic, projectPublic, suggestTags, writePages, writeSynopsis } from "../gen/index.ts";
import { summarizeReviews } from "../nkg/reviewSummary.ts";
import { autoCheck, formatNotice } from "../check/index.ts";
import type { StageContext, StageResult } from "./context.ts";
import { renameSyncRetry } from "../util/fsRetry.ts";

/**
 * M1 job runner: S0 identify → S1 research → S2 NKG for one work (REQUIREMENTS 1.1, 4.4).
 * File-based, resumable per stage. The full queue (inbox/ready/running/…) is M4 (WP-4.2); here a job is
 * driven by `sfsh job run|resume` and its state lives in logs/jobs/<job_id>.state.json.
 */

export const STAGES = [
  "identify",
  // AMENDMENT 12: plot frame first (event-granular synopsis sources), then the analysis frame
  "search_plot",
  "search_r1",
  "claims_r1",
  // AMENDMENT 12: coverage-driven follow-up (claim coverage → targeted rounds) before the review, so review_r1
  // checks the follow-up claims together with the rest
  "followup",
  "review_r1",
  "modules",
  "phases",
  "fact",
  // AMENDMENT 12: shortfall detection on the NKG fact layer → targeted research → rebuild modules/phases/fact
  "gapfill",
  "refact",
  "interp",
  "assemble",
  "check",
  // S3 (M2, CP-026): Luna tags → deterministic projection → Haiku pages (Luna review) → deterministic compose
  "tags",
  "project",
  "write",
  "compose",
  // S4 (M3): automatic check A-1/A-2 (fix only the matching parts) + advisory report — never stops the work (P-1)
  "autocheck",
] as const;
export type StageName = (typeof STAGES)[number];

/** 4.4: automatic retry up to 2 times per stage, then failed. */
export const MAX_ATTEMPTS = 3;

export type JobStateName = "received" | "identifying" | "clarifying" | "researching" | "structuring" | "generating" | "checking" | "held" | "done" | "failed";

export interface StageRecord {
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  metrics: Record<string, number | string>;
  warnings: string[];
  error: string | null;
}

export interface JobRequestLite {
  job_id: string;
  received_at: string;
  origin: "cli" | "muse" | "discord";
  work_query: string;
  medium_hint: string | null;
  range_raw: string;
  range: StageContext["range"];
  instruction_urls: { url: string; note: string }[];
}

export interface JobState {
  job_id: string;
  request: JobRequestLite;
  state: JobStateName;
  work_id: string | null;
  resolved: unknown;
  clarify: unknown;
  budget: BudgetState;
  stages: Record<StageName, StageRecord>;
  updated_at: string;
  pid: number | null;
  error: string | null;
}

export interface RunnerDeps {
  luna: ModelPort;
  haiku: ModelPort;
  fetcher: Fetcher;
  worksDir: string;
  jobsDir: string;
  now?: () => Date;
  /** Stop after this stage (e.g. "identify" for identification-only runs). */
  until?: StageName;
  /** Override stage implementations (tests). */
  stageOverrides?: Partial<Record<StageName, (ctx: StageContext) => Promise<StageResult>>>;
  /** M4 queue worker: called after every write of the state file (the worker mirrors st.state into the queue file). */
  onState?: (st: JobState) => void;
  /**
   * M4 queue worker: checked at each stage boundary (before a stage that is not done yet). A non-null reason stops
   * the run there; the state file is left resumable (stage records untouched, pid cleared). Used for cancel (§4.4).
   */
  shouldStop?: () => string | null;
  /**
   * M6 (CP-041 finding a): awaited at each stage boundary (before a stage that is not done yet, before shouldStop).
   * The queue worker identifies newly received requests here so that clarifying / merge answers do not wait for
   * the whole running job. Must not throw (errors are the caller's to log); it must not touch this job's state file.
   */
  atBoundary?: () => Promise<void>;
  /** AMENDMENT 12: research frame plan (default FRAMES). */
  frames?: FramePlan;
  /** AMENDMENT 12: S2 fact / interp review rounds for this run (1..2). Absent = REVIEW_MAX_ROUNDS (2). */
  reviewRounds?: number;
}

// ---------- state files ----------

export function statePath(jobsDir: string, jobId: string): string {
  return path.join(jobsDir, `${jobId}.state.json`);
}
export function logPath(jobsDir: string, jobId: string): string {
  return path.join(jobsDir, `${jobId}.log`);
}

export function readState(jobsDir: string, jobId: string): JobState {
  const st = JSON.parse(fs.readFileSync(statePath(jobsDir, jobId), "utf8")) as JobState;
  // State files written before later stages existed (e.g. M1 jobs before S3) get pending records.
  for (const name of STAGES)
    st.stages[name] ??= { status: "pending", attempts: 0, started_at: null, finished_at: null, duration_ms: null, metrics: {}, warnings: [], error: null };
  return st;
}

/** Atomic write of logs/jobs/<job_id>.state.json (exported for the M4 queue worker's recovery / candidate pick). */
export function writeState(jobsDir: string, st: JobState, now: Date): void {
  writeStateFile(jobsDir, st, now);
}

function writeStateFile(jobsDir: string, st: JobState, now: Date): void {
  st.updated_at = isoLocal(now);
  const file = statePath(jobsDir, st.job_id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n", "utf8");
  renameSyncRetry(tmp, file);
}

function appendLog(jobsDir: string, jobId: string, msg: string, now: Date): void {
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.appendFileSync(logPath(jobsDir, jobId), `${isoLocal(now)} ${msg}\n`, "utf8");
}

/** Next job id `YYYYMMDD-NNNN` (4.1). */
export function nextJobId(jobsDir: string, now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let max = 0;
  if (fs.existsSync(jobsDir)) {
    for (const f of fs.readdirSync(jobsDir)) {
      // M4: the queue reserves ids by creating <id>.log (queue/store.ts allocateJobId) — skip those too.
      const m = f.match(new RegExp(`^${day}-(\\d{4})\\.(?:state\\.json|log)$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${day}-${pad(max + 1, 4)}`;
}

/** Minimal range parsing for M1 (full grammar = WP-4.3 in M4). Unparsed input is kept in range_raw. */
export function parseRangeLite(raw: string): StageContext["range"] {
  const s = raw.normalize("NFKC").trim();
  if (s === "" || s === "全体" || s === "whole") return [{ unit: "whole", from: null, to: null, label: "全体" }];
  let m = s.match(/^全?(\d+)話$/);
  if (m) return [{ unit: "episode", from: 1, to: Number(m[1]), label: s }];
  m = s.match(/^(\d+)(?:-(\d+))?話$/);
  if (m) return [{ unit: "episode", from: Number(m[1]), to: Number(m[2] ?? m[1]), label: s }];
  m = s.match(/^(\d+)(?:-(\d+))?巻$/);
  if (m) return [{ unit: "volume", from: Number(m[1]), to: Number(m[2] ?? m[1]), label: s }];
  return [{ unit: "whole", from: null, to: null, label: s }];
}

export function newJobState(
  req: { workQuery: string; mediumHint: string | null; rangeRaw: string; instructionUrls?: { url: string; note: string }[]; jobId: string },
  now: Date,
  limits: BudgetLimits = DEFAULT_BUDGET,
): JobState {
  const at = isoLocal(now);
  const stages = Object.fromEntries(
    STAGES.map((s) => [s, { status: "pending", attempts: 0, started_at: null, finished_at: null, duration_ms: null, metrics: {}, warnings: [], error: null }]),
  ) as unknown as Record<StageName, StageRecord>;
  return {
    job_id: req.jobId,
    request: {
      job_id: req.jobId,
      received_at: at,
      origin: "cli",
      work_query: req.workQuery,
      medium_hint: req.mediumHint,
      range_raw: req.rangeRaw,
      range: parseRangeLite(req.rangeRaw),
      instruction_urls: req.instructionUrls ?? [],
    },
    state: "received",
    work_id: null,
    resolved: null,
    clarify: null,
    budget: { limits: { ...limits }, searchesUsed: 0, fetchesUsed: 0, startedAt: at },
    stages,
    updated_at: at,
    pid: null,
    error: null,
  };
}

// ---------- stage table ----------

function workBrief(workDir: string) {
  const w = readWork(workDir);
  return {
    title: w.title,
    creators: (w.creators ?? []).map((c: unknown) => (typeof c === "string" ? c : String((c as { name?: string }).name ?? ""))),
    medium: w.medium,
    first_release: w.first_release_year != null ? String(w.first_release_year) : null,
  };
}

/**
 * S3/S4 stages that only read existing research / NKG / projection outputs and never search or fetch
 * (AMENDMENT 09: `sfsh regen` re-runs them for an existing work). The job runner and regen share these functions.
 */
export const OFFLINE_STAGES = ["write", "compose", "autocheck"] as const satisfies readonly StageName[];
export type OfflineStageName = (typeof OFFLINE_STAGES)[number];

export function offlineStage(name: OfflineStageName): (ctx: StageContext) => Promise<StageResult> {
  switch (name) {
    case "write":
      return async (ctx) => {
        // AMENDMENT 11: the page text and the long synopsis are written in parallel (both read the projection only
        // and write separate files); ctx.writeParts selects one of them (regen --parts).
        const parts = ctx.writeParts ?? ["pages", "synopsis"];
        const results = await Promise.all([parts.includes("pages") ? writePages(ctx) : null, parts.includes("synopsis") ? writeSynopsis(ctx) : null]);
        const done = results.filter((x): x is StageResult => !!x);
        const r: StageResult = { outputs: done.flatMap((x) => x.outputs), metrics: Object.assign({}, ...done.map((x) => x.metrics)), warnings: done.flatMap((x) => x.warnings) };
        try {
          summarizeReviews(ctx.workDir, ctx.now()); // include gen/reviews/*.json in review_summary + work.json review_stats (3.3-4)
        } catch (e) {
          r.warnings.push(`review summary failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return r;
      };
    case "compose":
      return composePublic;
    case "autocheck":
      return autoCheck;
  }
}

const ROUND1_ASPECTS = ["bibliographic", "M01", "M03", "M02", "M06", "M07", "M10", "M12", "M05", "M08", "M09", "M04", "M11"];

function defaultStage(name: Exclude<StageName, "identify">, st: JobState): (ctx: StageContext) => Promise<StageResult> {
  switch (name) {
    case "search_plot":
      return (ctx) => runPlotSearch(ctx, { work: workBrief(ctx.workDir) });
    case "search_r1":
      return (ctx) =>
        runSearch(ctx, {
          round: 1,
          aspects: ROUND1_ASPECTS,
          work: workBrief(ctx.workDir),
          maxSearches: 14,
          instructionUrls: st.request.instruction_urls,
          // AMENDMENT 12: the analysis frame's allowance leaves the reserve for the coverage rounds
          allowance: allowance(ctx.budget, (ctx.frames ?? FRAMES).analysis.cap, (ctx.frames ?? FRAMES).analysis.reserve),
        });
    case "claims_r1":
      return (ctx) => extractClaims(ctx, { workTitle: workBrief(ctx.workDir).title });
    case "review_r1":
      return (ctx) => reviewClaims(ctx, { maxRounds: 2, workTitle: workBrief(ctx.workDir).title });
    case "followup":
      return (ctx) => coverageFollowUp(ctx, { work: workBrief(ctx.workDir) });
    case "gapfill":
      return (ctx) => gapFill(ctx, { work: workBrief(ctx.workDir) });
    case "refact":
      return refact;
    case "modules":
      return selectModules;
    case "phases":
      return buildPhases;
    case "fact":
      return (ctx) => (ctx.reviewRounds ? buildFactLayer(ctx, ctx.reviewRounds) : buildFactLayer(ctx));
    case "interp":
      return (ctx) => (ctx.reviewRounds ? buildInterpLayer(ctx, ctx.reviewRounds) : buildInterpLayer(ctx));
    case "assemble":
      return assembleNkg;
    case "check":
      return async (ctx) => checkStage(ctx, st);
    case "tags":
      return suggestTags;
    case "project":
      return projectPublic;
    case "write":
    case "compose":
    case "autocheck":
      return offlineStage(name);
  }
}

/** Final deterministic check (M1 gate items): NKG validation + source-card traceability + gaps. */
export async function checkStage(ctx: StageContext, st: JobState): Promise<StageResult> {
  const v = validateNkgFile(ctx.workDir, ctx.now());
  const violations = assertCardsTraceable(ctx.workDir, st.request.instruction_urls.map((u) => u.url));
  const nkg = JSON.parse(fs.readFileSync(path.join(ctx.workDir, "nkg", "nkg.json"), "utf8"));
  const elements = [...nkg.nodes, ...nkg.edges];
  const noProv = elements.filter((e: any) => !e.meta?.provenance?.length).length;
  const noConf = elements.filter((e: any) => !e.meta?.confidence?.grade).length;
  const claims = readClaims(ctx.workDir);
  const fetchLog = readFetchLog(ctx.workDir);
  const byDecision: Record<string, number> = {};
  for (const d of fetchLog) byDecision[d.decision] = (byDecision[d.decision] ?? 0) + 1;
  // CP-025: the budget unit is "page GETs issued by this job" (FetchDecision.get_issued). Merged jobs keep
  // their own budgets (4.5: each job has its own §1.3 limits); fetch_log is per work (all jobs).
  const mine = fetchLog.filter((d) => (d.job_id ?? jobIdOfOrigin(d.origin)) === st.job_id);
  const stamped = mine.filter((d) => d.get_issued !== undefined);
  const getsThisJob = stamped.filter((d) => d.get_issued).length;
  const summary = {
    job_id: st.job_id,
    work_id: ctx.workId,
    nkg_valid: v.ok,
    nkg_errors: v.errors.length,
    nkg_warnings: v.warnings.length,
    nodes: nkg.nodes.length,
    edges: nkg.edges.length,
    elements_without_provenance: noProv,
    elements_without_confidence: noConf,
    nkg_gaps: nkg.gaps.length,
    research_gaps: readGaps(ctx.workDir).length,
    sources: readSources(ctx.workDir).length,
    claims_active: claims.filter((c) => c.status === "active").length,
    claims_dropped: claims.filter((c) => c.status === "dropped").length,
    traceability_violations: violations.length,
    fetch_decisions: byDecision,
    fetch_decisions_scope: "work (all jobs)",
    budget: { ...ctx.budget },
    budget_fetches_this_job: ctx.budget.fetchesUsed,
    fetch_gets_this_job: stamped.length === mine.length ? getsThisJob : "unstamped (pre-CP-025 records)",
    fetch_gets_consistent: stamped.length === mine.length ? getsThisJob === ctx.budget.fetchesUsed : "n/a",
  };
  fs.writeFileSync(path.join(ctx.workDir, "nkg", "check_summary.json"), JSON.stringify({ ...summary, violations, errors: v.errors.slice(0, 50) }, null, 2) + "\n", "utf8");
  const metrics: Record<string, number | string> = {};
  for (const [k, val] of Object.entries(summary)) if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") metrics[k] = typeof val === "boolean" ? (val ? 1 : 0) : val;
  const warnings: string[] = [];
  if (!v.ok) warnings.push(`nkg validation errors: ${v.errors.slice(0, 3).join(" | ")}`);
  if (violations.length) warnings.push(`traceability violations: ${violations.slice(0, 3).join(" | ")}`);
  if (!v.ok) throw new Error(`NKG validation failed (${v.errors.length} errors): ${v.errors.slice(0, 2).join(" | ")}`);
  if (violations.length) throw new Error(`source cards not traceable to search events/instruction: ${violations.slice(0, 2).join(" | ")}`);
  return { outputs: ["nkg/check_summary.json"], metrics, warnings };
}

/** M1 records have no job_id: callIds start with the job id ("20261123-0001-s0-…" / "20261123-0001:s1…"). */
export function jobIdOfOrigin(o: { kind: string; callId?: string }): string | null {
  const m = o.kind === "search_event" && o.callId ? o.callId.match(/^(\d{8}-\d{4})/) : null;
  return m ? m[1]! : null;
}

/** Per-job budget record under the work (CP-025): research/budgets/<job_id>.json. */
export function writeJobBudget(workDir: string, jobId: string, budget: BudgetState): void {
  const dir = path.join(workDir, "research", "budgets");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ job_id: jobId, ...budget }, null, 2) + "\n", "utf8");
  renameSyncRetry(`${file}.tmp`, file);
}

// ---------- runner ----------

/** S4 completion notice text for a finished job (null when the job did not run S4). */
export function completionNotice(worksDir: string, st: JobState): string | null {
  if (!st.work_id || st.stages.autocheck?.status !== "done") return null;
  const f = path.join(worksDir, st.work_id, "check", "report.json");
  if (!fs.existsSync(f)) return null;
  return formatNotice(JSON.parse(fs.readFileSync(f, "utf8")).notice);
}

const HOLD_EVENTS = new Set(["hold", "takedown", "purge"]);

/** Returns a description of the hold that applies to this job, or null (work Public, or Restricted before the job was received). */
export function holdAfterReceipt(worksDir: string, st: JobState): string | null {
  if (!st.work_id) return null;
  const dir = path.join(worksDir, st.work_id);
  if (!fs.existsSync(path.join(dir, "work.json"))) return null;
  const w = readWork(dir);
  if (w.publish_mode !== "Restricted") return null;
  const received = Date.parse(st.request.received_at);
  const ev = [...(w.history ?? [])].reverse().find((h) => HOLD_EVENTS.has(h.event));
  if (!ev) return null;
  return Date.parse(ev.at) >= received ? `${ev.event} at ${ev.at}` : null;
}

export async function runJob(st: JobState, deps: RunnerDeps): Promise<JobState> {
  const now = deps.now ?? (() => new Date());
  const log = (m: string) => appendLog(deps.jobsDir, st.job_id, m, now());
  const writeState = (jobsDir: string, s: JobState, at: Date) => {
    writeStateFile(jobsDir, s, at);
    deps.onState?.(s);
  };
  st.pid = process.pid;
  st.error = null;
  writeState(deps.jobsDir, st, now());
  log(`run start pid=${process.pid} state=${st.state}`);

  for (const name of STAGES) {
    st.stages[name] ??= { status: "pending", attempts: 0, started_at: null, finished_at: null, duration_ms: null, metrics: {}, warnings: [], error: null };
    const rec = st.stages[name];
    if (rec.status === "done") continue;
    if (st.state === "clarifying") break;
    if (deps.atBoundary) await deps.atBoundary();
    const stop = deps.shouldStop?.() ?? null;
    if (stop) {
      st.pid = null;
      writeState(deps.jobsDir, st, now());
      log(`stopped before stage ${name}: ${stop}`);
      return st;
    }
    // 5.4 hold: a job whose work was held (hold/takedown/purge recorded after the job was received) stops at the
    // next stage boundary in state "held". A new job for an already-Restricted work proceeds (4.4: accepted, never published).
    const heldBy = name === "identify" ? null : holdAfterReceipt(deps.worksDir, st);
    if (heldBy) {
      st.state = "held";
      st.pid = null;
      writeState(deps.jobsDir, st, now());
      log(`held before stage ${name}: work ${st.work_id} is Restricted (${heldBy})`);
      return st;
    }
    st.state = name === "identify" ? "identifying" : ["search_plot", "search_r1", "claims_r1", "review_r1", "followup"].includes(name) ? "researching" : ["tags", "project", "write", "compose"].includes(name) ? "generating" : name === "autocheck" ? "checking" : "structuring";

    let ok = false;
    while (rec.attempts < MAX_ATTEMPTS) {
      rec.attempts++;
      rec.status = "running";
      rec.started_at = isoLocal(now());
      rec.error = null;
      writeState(deps.jobsDir, st, now());
      log(`stage ${name} start (attempt ${rec.attempts}/${MAX_ATTEMPTS})`);
      const t0 = Date.now();
      try {
        const r = name === "identify" ? await runIdentify(st, deps, log, now) : await runStage(name, st, deps, log, now);
        rec.metrics = r.metrics;
        rec.warnings = r.warnings.slice(0, 50);
        rec.status = "done";
        ok = true;
      } catch (e) {
        rec.error = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
        rec.status = "failed";
        log(`stage ${name} error: ${rec.error}`);
      }
      rec.finished_at = isoLocal(now());
      rec.duration_ms = Date.now() - t0;
      writeState(deps.jobsDir, st, now());
      if (ok) {
        log(`stage ${name} done in ${Math.round(rec.duration_ms / 1000)}s ${JSON.stringify(rec.metrics)}`);
        break;
      }
    }
    if (!ok) {
      st.state = "failed";
      st.error = `stage ${name} failed after ${rec.attempts} attempts: ${rec.error}`;
      writeState(deps.jobsDir, st, now());
      log(`job failed: ${st.error}`);
      return st;
    }
    if ((st.state as JobStateName) === "clarifying") break;
    if (deps.until === name) {
      log(`stopping after ${name} (--until)`);
      st.pid = null;
      writeState(deps.jobsDir, st, now());
      return st;
    }
  }
  if ((st.state as JobStateName) !== "clarifying") st.state = "done";
  st.pid = null;
  writeState(deps.jobsDir, st, now());
  // 4.2 / 5.2: the completion notice carries the S4 summary and advisory points (no generated text).
  const notice = st.state === "done" ? completionNotice(deps.worksDir, st) : null;
  if (notice) log(`notice: ${notice.split(String.fromCharCode(10)).join(" / ")}`);
  log(`run end state=${st.state}`);
  return st;
}

async function runIdentify(st: JobState, deps: RunnerDeps, log: (m: string) => void, now: () => Date): Promise<StageResult> {
  const override = deps.stageOverrides?.identify;
  if (override) throw new Error("identify cannot be overridden");
  const r = await identify(
    { jobId: st.job_id, workQuery: st.request.work_query, mediumHint: st.request.medium_hint },
    { luna: deps.luna, fetcher: deps.fetcher, worksDir: deps.worksDir, budget: st.budget, now, log },
  );
  if (r.status === "clarifying") {
    st.state = "clarifying";
    st.clarify = { reason: r.reason, candidates: r.candidates ?? [] };
    log(`identify → clarifying (${r.reason})`);
  } else {
    st.work_id = r.resolved!.work_id;
    st.resolved = r.resolved;
    writeJobBudget(path.join(deps.worksDir, st.work_id), st.job_id, st.budget);
    if (r.notice) log(`notice: ${r.notice}`);
    log(`identify → ${r.resolved!.work_id} (${r.resolved!.method}, ${r.resolved!.title_status})`);
  }
  return { outputs: [], metrics: { ...r.metrics, status: r.status }, warnings: r.notice ? [r.notice] : [] };
}

async function runStage(name: Exclude<StageName, "identify">, st: JobState, deps: RunnerDeps, log: (m: string) => void, now: () => Date): Promise<StageResult> {
  if (!st.work_id) throw new Error(`stage ${name} needs a resolved work_id`);
  const workDir = path.join(deps.worksDir, st.work_id);
  const ctx: StageContext = {
    jobId: st.job_id,
    workDir,
    workId: st.work_id,
    range: st.request.range,
    luna: deps.luna,
    haiku: deps.haiku,
    fetcher: deps.fetcher,
    budget: st.budget,
    now,
    log,
    frames: deps.frames,
    reviewRounds: deps.reviewRounds,
  };
  const fn = deps.stageOverrides?.[name] ?? defaultStage(name, st);
  const r = await fn(ctx);
  writeBudget(workDir, st.budget);
  writeJobBudget(workDir, st.job_id, st.budget);
  return r;
}
