/**
 * The single queue worker (WP-4.2, REQUIREMENTS §4.4, PLAN §3).
 *
 * One pass:
 *  1. start-up recovery (once): reconcileDirs; jobs left in running/ by a dead worker get their runner "running"
 *     stages back to "pending" (attempt counters kept: a kill counts as one attempt) and return to queued;
 *     inbox jobs left "identifying" return to received.
 *  2. adoptInboxDrops (Muse JSON drops).
 *  3. intake: EVERY received inbox job is identified before any main processing (§4.4, §4.5): range null →
 *     clarifying (range_unparsed, identify not run); otherwise the runner runs only the identify stage; clarifying →
 *     candidates + notice; resolved → idempotency key → merge or queued (+ restricted / identified notices).
 *  4. main: one ready job (priority high first → received_at → batch line) runs the remaining stages; the queue
 *     state follows the runner (researching/structuring/generating/checking); done → building (site build, 3 attempts)
 *     → built (→ published when deps.publish is wired: gate open + mode auto, M5); failed / held → their folders;
 *     a cancel request stops the run at the next stage boundary.
 *  5. notices with reply_to null (CLI / Muse) are written to logs/jobs/<job_id>.log and moved to outbox/sent (via "local").
 * Every saveJob of any job is followed by deps.afterTransition(job) (batch records, wired by the orchestrator).
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import { build as siteBuild } from "../site/build.ts";
import {
  completionNotice,
  newJobState,
  readState,
  runJob,
  STAGES,
  statePath,
  writeJobBudget,
  writeState,
  type JobState,
  type RunnerDeps,
  type StageName,
} from "../job/runner.ts";
import type { ModelPort } from "../model/types.ts";
import { finalizeStagedCandidate, normalizeQuery, resolvePickedWork, type IdentifyResult } from "../research/identify/index.ts";
import type { Fetcher } from "../research/types.ts";
import { isWorkRestricted } from "../works/ops.ts";
import { applyMerge, findMergeTarget, idempotencyKey } from "./idempotency.ts";
import { acquireWorkerLock, appendWorkerLog } from "./lock.ts";
import { listPendingNotices, markNoticeSent } from "./notify.ts";
import { clarifyText, effectiveMedium, effectiveQuery, notifyJob, pendingPick } from "./ops.ts";
import { parseRange } from "./range.ts";
import { adoptInboxDrops } from "./request.ts";
import { refreshAllBatches, refreshBatchForJob } from "./batch/refresh.ts";
import { appendJobLog, ensureQueueDirs, findJob, listJobs, reconcileDirs, saveJob, type QueueEnv } from "./store.ts";
import type { ClarifyInfo, JobRequest, JobStateName, RangeItem } from "./types.ts";

export interface WorkerDeps {
  luna: ModelPort;
  haiku: ModelPort;
  fetcher: Fetcher;
  now?: () => Date;
  stageOverrides?: RunnerDeps["stageOverrides"];
  /** Site build for the building state (default: site/build.ts build()). */
  build?: (opts: { worksDir: string; out: string }) => Promise<unknown>;
  /** Called after every saveJob of any job (batch record update). */
  afterTransition?: (job: JobRequest) => void;
  /**
   * M5 S6: publish after built (wired only when the production gate is open AND publish.mode is "auto"; §5.3:
   * before the site opening every job stops at built). ok → state published; not ok → the job stays built.
   */
  publish?: (ctx: { jobId: string; workId: string }) => Promise<{ ok: boolean; summary: string; release_id: string | null }>;
}

export interface WorkerOptions {
  /** Process until nothing is left to do (no received / queued job), then exit. */
  once?: boolean;
  pollMs?: number;
  /** Stop after this many main (pipeline) runs. */
  maxJobs?: number;
  signal?: AbortSignal;
}

export interface WorkerSummary {
  tookOverFrom: number | null;
  recovered: string[];
  identified: string[];
  processed: { job_id: string; state: JobStateName }[];
}

export const BUILD_ATTEMPTS = 3;
const RUNNING_STATES: readonly JobStateName[] = ["researching", "structuring", "generating", "checking", "building"];

/** Runner stage → queue state (same grouping as job/runner.ts). */
export function stateOfStage(name: StageName): JobStateName {
  if (name === "identify") return "identifying";
  if (["search_r1", "claims_r1", "review_r1", "followup"].includes(name)) return "researching";
  if (["tags", "project", "write", "compose"].includes(name)) return "generating";
  if (name === "autocheck") return "checking";
  return "structuring";
}

function queueStateOfRunner(s: string): JobStateName | null {
  return s === "researching" || s === "structuring" || s === "generating" || s === "checking" ? s : null;
}

/** Ready order: priority high first, then received_at, then batch line, then job id. */
export function readyOrder(jobs: JobRequest[]): JobRequest[] {
  return [...jobs].sort((a, b) => {
    const pa = a.options.priority === "high" ? 0 : 1;
    const pb = b.options.priority === "high" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.received_at !== b.received_at) return a.received_at < b.received_at ? -1 : 1;
    const la = a.batch?.line ?? 0;
    const lb = b.batch?.line ?? 0;
    if (la !== lb) return la - lb;
    return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runWorker(env: QueueEnv, depsIn: WorkerDeps, opts: WorkerOptions = {}): Promise<WorkerSummary> {
  // Orchestrator wiring (CP-038): by default every transition refreshes the job's batch record (§4.5).
  const deps: WorkerDeps = { ...depsIn, afterTransition: depsIn.afterTransition ?? ((j) => void refreshBatchForJob(env, j, (depsIn.now ?? (() => new Date()))())) };
  const now = deps.now ?? (() => new Date());
  const build = deps.build ?? ((o: { worksDir: string; out: string }) => siteBuild({ worksDir: o.worksDir, out: o.out }));
  const pollMs = opts.pollMs ?? 2000;
  const summary: WorkerSummary = { tookOverFrom: null, recovered: [], identified: [], processed: [] };
  ensureQueueDirs(env);
  const lock = acquireWorkerLock(env, now);
  summary.tookOverFrom = lock.tookOverFrom;
  appendWorkerLog(env, `worker start${opts.once ? " (once)" : ""}${opts.maxJobs != null ? ` max-jobs=${opts.maxJobs}` : ""}${lock.tookOverFrom !== null ? ` (took over stale lock of pid ${lock.tookOverFrom})` : ""}`, now());

  /** Fresh read → mutate → save → afterTransition. Skips (returns null) when the job is gone or not in `expect`. */
  const update = (jobId: string, expect: readonly JobStateName[] | null, mutate: (j: JobRequest) => void, note: string | null): JobRequest | null => {
    const loc = findJob(env, jobId);
    if (!loc) return null;
    if (expect && !expect.includes(loc.job.state)) return null;
    mutate(loc.job);
    const saved = saveJob(env, loc.job, note, now());
    deps.afterTransition?.(saved.job);
    return saved.job;
  };
  const jlog = (jobId: string, m: string) => appendJobLog(env, jobId, m, now());
  const runnerDeps = (extra: Partial<RunnerDeps>): RunnerDeps => ({
    luna: deps.luna,
    haiku: deps.haiku,
    fetcher: deps.fetcher,
    worksDir: env.worksDir,
    jobsDir: env.jobsDir,
    now,
    stageOverrides: deps.stageOverrides,
    ...extra,
  });

  /** Runner "running" stages (a dead worker's) → pending; attempt counts kept. */
  const resetRunning = (jobId: string, why: string): string[] => {
    if (!fs.existsSync(statePath(env.jobsDir, jobId))) return [];
    const st = readState(env.jobsDir, jobId);
    const reset: string[] = [];
    for (const s of STAGES) {
      if (st.stages[s].status === "running") {
        st.stages[s].status = "pending";
        reset.push(`${s}@attempt${st.stages[s].attempts}`);
      }
    }
    if (reset.length || st.pid !== null) {
      const pid = st.pid;
      st.pid = null;
      writeState(env.jobsDir, st, now());
      jlog(jobId, `${why}: ${reset.length ? `stage ${reset.join(", ")} was running${pid ? ` (pid ${pid})` : ""} → pending, attempt count kept` : `stale pid ${pid} cleared`}`);
    }
    return reset;
  };

  // ------------------------------------------------------------ 1. recovery
  const recover = (): void => {
    for (const m of reconcileDirs(env, now())) summary.recovered.push(`reconcile ${m}`);
    for (const { job } of listJobs(env, ["running"])) {
      const reset = resetRunning(job.job_id, "worker recovery");
      if (job.cancel_requested) {
        const j = update(job.job_id, null, (x) => (x.state = "cancelled"), `worker recovery: cancel was requested before the worker stopped (was ${job.state})`);
        if (j) notifyJob(env, j, "cancelled", `取消: ${j.job_id}「${j.resolved?.title ?? j.work_query}」を取り消しました（${job.state} で停止）`, { previous_state: job.state }, now());
      } else {
        update(job.job_id, null, (x) => (x.state = "queued"), `worker recovery: was ${job.state} when the previous worker stopped; resumes from the first unfinished stage${reset.length ? ` (re-run ${reset.join(", ")})` : ""}`);
      }
      summary.recovered.push(`${job.job_id}: ${job.state} -> ${job.cancel_requested ? "cancelled" : "queued"}${reset.length ? ` (reset ${reset.join(",")})` : ""}`);
    }
    for (const { job } of listJobs(env, ["inbox"])) {
      if (job.state !== "identifying") continue;
      resetRunning(job.job_id, "worker recovery (intake)");
      update(job.job_id, null, (x) => (x.state = "received"), "worker recovery: identification was interrupted; identifies again");
      summary.recovered.push(`${job.job_id}: identifying -> received`);
    }
    if (summary.recovered.length) appendWorkerLog(env, `recovery: ${summary.recovered.join("; ")}`, now());
    // Batch notices a previous worker may have missed (crash between a transition and the batch refresh).
    for (const r of refreshAllBatches(env, now())) if (r.emitted?.length) appendWorkerLog(env, `batch recovery: ${r.batch_id} emitted ${r.emitted.join(",")}`, now());
  };

  // ------------------------------------------------------------ 3. intake
  const loadOrCreateState = (job: JobRequest): JobState => {
    let st: JobState;
    if (fs.existsSync(statePath(env.jobsDir, job.job_id))) st = readState(env.jobsDir, job.job_id);
    else {
      st = newJobState(
        { jobId: job.job_id, workQuery: effectiveQuery(job), mediumHint: effectiveMedium(job), rangeRaw: job.range_raw, instructionUrls: job.instruction_urls },
        now(),
      );
      st.request.received_at = job.received_at;
      st.request.origin = job.origin;
    }
    st.request.range = (job.range ?? []) as JobState["request"]["range"];
    return st;
  };

  const clarify = (job: JobRequest, info: Omit<ClarifyInfo, "message" | "asked_at">, note: string, rangeReason: string | null = null): void => {
    const full: ClarifyInfo = { ...info, asked_at: "", message: "" };
    const j = update(
      job.job_id,
      ["received", "identifying"],
      (x) => {
        full.asked_at = isoLocal(now());
        full.message = clarifyText(x, full, rangeReason);
        x.clarify = full;
        x.state = "clarifying";
      },
      note,
    );
    if (!j) return;
    const n = j.answers.length;
    notifyJob(env, j, "clarifying", j.clarify!.message, { reason: info.reason, candidates: info.candidates }, now(), { suffix: n ? `-${n}` : "" });
  };

  const applyPick = (job: JobRequest, st: JobState): IdentifyResult | Error => {
    const p = pendingPick(job)!;
    const log = (m: string) => jlog(job.job_id, m);
    try {
      const r = p.candidate.work_id
        ? resolvePickedWork({ jobId: job.job_id, workQuery: effectiveQuery(job), mediumHint: effectiveMedium(job) }, p.candidate.work_id, { worksDir: env.worksDir, now, log })
        : finalizeStagedCandidate({ jobId: job.job_id, pick: p.pick }, { worksDir: env.worksDir, now, log });
      const rec = st.stages.identify;
      if (r.status === "resolved") {
        st.work_id = r.resolved!.work_id;
        st.resolved = r.resolved;
        st.clarify = null;
        st.state = "identifying";
        rec.status = "done";
        rec.attempts = Math.max(1, rec.attempts);
        rec.finished_at = r.resolved!.resolved_at;
        rec.error = null;
        rec.metrics = { ...r.metrics, status: "resolved", picked: p.pick };
        writeJobBudget(path.join(env.worksDir, st.work_id), st.job_id, st.budget);
        log(`identify → ${st.work_id} by pick ${p.pick} (${r.resolved!.method}, ${r.resolved!.title_status}); no new search`);
      } else {
        st.state = "clarifying";
        st.clarify = { reason: r.reason, candidates: r.candidates ?? [] };
      }
      writeState(env.jobsDir, st, now());
      return r;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  };

  const intakeOne = async (jobId: string): Promise<void> => {
    let job: JobRequest | null | undefined = findJob(env, jobId)?.job;
    if (!job || job.state !== "received") return;
    if (job.range === null) {
      const p = parseRange(job.range_raw);
      clarify(job, { reason: "range_unparsed", candidates: [] }, `range "${job.range_raw}" unparsed (${!p.ok ? p.reason : "?"}); identification not run`, !p.ok ? p.reason : null);
      return;
    }
    job = update(jobId, ["received"], (x) => (x.state = "identifying"), `identification start (query "${effectiveQuery(job!)}"${effectiveMedium(job!) ? `, medium ${effectiveMedium(job!)}` : ""})`);
    if (!job) return;
    let st = loadOrCreateState(job);
    if (pendingPick(job)) {
      const r = applyPick(job, st);
      if (r instanceof Error) {
        jlog(jobId, `pick could not be resolved: ${r.message}`);
        clarify(job, { reason: "no_candidates", candidates: [] }, `picked candidate could not be resolved (${r.message}); asks for the work again`);
        return;
      }
    } else if (st.state === "clarifying" || st.state === "failed" || st.stages.identify.status !== "done" || !st.work_id) {
      if (st.state === "clarifying" || st.state === "failed") {
        // answered (work / medium / range) or re-submitted: identify again with the answered words
        Object.assign(st.stages.identify, { status: "pending", attempts: 0, error: null });
        st.clarify = null;
        st.state = "received";
      }
      st.request.work_query = effectiveQuery(job);
      st.request.medium_hint = effectiveMedium(job);
      writeState(env.jobsDir, st, now());
      st = await runJob(st, runnerDeps({ until: "identify" }));
    }
    // outcome
    if (st.state === "failed") {
      const j = update(jobId, ["identifying"], (x) => ((x.state = "failed"), (x.error = st.error)), `identification failed: ${st.error}`);
      if (j) notifyJob(env, j, "failed", `失敗: ${jobId}「${j.work_query}」の作品同定に失敗しました（${st.error ?? "?"}）`, { stage: "identify", error: st.error }, now());
      return;
    }
    if (st.state === "clarifying") {
      const c = (st.clarify ?? {}) as { reason?: ClarifyInfo["reason"]; candidates?: ClarifyInfo["candidates"] };
      clarify(job, { reason: c.reason ?? "no_candidates", candidates: c.candidates ?? [] }, `identify → clarifying (${c.reason}, ${(c.candidates ?? []).length} candidates)`);
      return;
    }
    if (!st.work_id || !st.resolved) {
      const j = update(jobId, ["identifying"], (x) => ((x.state = "failed"), (x.error = "identification ended without a work_id")), "identification ended without a work_id");
      if (j) notifyJob(env, j, "failed", `失敗: ${jobId}「${j.work_query}」の作品同定が完了しませんでした`, {}, now());
      return;
    }
    const resolved = st.resolved as JobRequest["resolved"] & {};
    const workId = st.work_id;
    const restricted = isWorkRestricted(env.worksDir, workId);
    const resolvedJob = update(
      jobId,
      ["identifying"],
      (x) => {
        x.resolved = resolved;
        x.idempotency_key = idempotencyKey(workId, x.range as RangeItem[]);
        x.clarify = null;
        x.error = null;
        if (restricted && !x.restricted_notice_at) x.restricted_notice_at = isoLocal(now());
      },
      `identified: ${workId} "${resolved.title}" (${resolved.method}, ${resolved.title_status}); key ${idempotencyKey(workId, job.range as RangeItem[])}${restricted ? "; work is Restricted (processed, never published)" : ""}`,
    );
    if (!resolvedJob) return;
    summary.identified.push(jobId);
    if (restricted)
      notifyJob(env, resolvedJob, "restricted", `Restricted: ${jobId}「${resolved.title}」（${workId}）は差し止め中（Restricted）の作品です。指示は受け付けて処理しますが、公開段へは進めません`, { work_id: workId }, now(), { includeMerged: false });
    if (normalizeQuery(resolvedJob.work_query) !== normalizeQuery(resolved.title))
      notifyJob(env, resolvedJob, "identified", `同定: ${jobId} 入力「${resolvedJob.work_query}」→ 正式名称「${resolved.title}」（${workId}、${resolved.title_status === "confirmed" ? "確定" : "暫定"}）`, { work_id: workId, title: resolved.title, title_status: resolved.title_status, method: resolved.method }, now(), { includeMerged: false });
    const target = findMergeTarget(env, resolvedJob);
    if (target) {
      applyMerge(env, resolvedJob, target, now(), { afterTransition: deps.afterTransition });
      return;
    }
    update(jobId, ["identifying"], (x) => (x.state = "queued"), `queued (priority ${resolvedJob.options.priority})`);
  };

  const intakeAll = async (): Promise<void> => {
    const received = listJobs(env, ["inbox"])
      .map((l) => l.job)
      .filter((j) => j.state === "received")
      .sort((a, b) => (a.received_at !== b.received_at ? (a.received_at < b.received_at ? -1 : 1) : (a.batch?.line ?? 0) - (b.batch?.line ?? 0) || (a.job_id < b.job_id ? -1 : 1)));
    for (const j of received) {
      if (opts.signal?.aborted) return;
      try {
        await intakeOne(j.job_id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        jlog(j.job_id, `intake error: ${msg}`);
        const f = update(j.job_id, ["received", "identifying"], (x) => ((x.state = "failed"), (x.error = `intake error: ${msg}`)), `intake error: ${msg}`);
        if (f) notifyJob(env, f, "failed", `失敗: ${f.job_id}「${f.work_query}」の受付処理でエラー（${msg}）`, { error: msg }, now());
      }
    }
  };

  // ------------------------------------------------------------ 4. main
  const titleOf = (j: JobRequest) => j.resolved?.title ?? j.work_query;

  const processMain = async (jobId: string): Promise<JobStateName | null> => {
    const loc = findJob(env, jobId);
    if (!loc || loc.job.state !== "queued") return null;
    if (!fs.existsSync(statePath(env.jobsDir, jobId))) {
      const f = update(jobId, ["queued"], (x) => ((x.state = "failed"), (x.error = "runner state file missing")), "runner state file missing; cannot run");
      if (f) notifyJob(env, f, "failed", `失敗: ${jobId}「${titleOf(f)}」の実行状態が見つかりません`, {}, now());
      return "failed";
    }
    resetRunning(jobId, "before run");
    let st = readState(env.jobsDir, jobId);
    const first = STAGES.find((s) => st.stages[s].status !== "done");
    let current: JobStateName = first ? stateOfStage(first) : "checking";
    if (current === "identifying") current = "researching";
    const picked = update(jobId, ["queued"], (x) => (x.state = current), `worker picked (priority ${loc.job.options.priority}); ${first ? `resumes at stage ${first}` : "all stages done"}`);
    if (!picked) return null;

    let stopReason: string | null = null;
    let cancelled = false;
    const shouldStop = (): string | null => {
      const f = findJob(env, jobId)?.job;
      if (f && (f.cancel_requested || f.state === "cancelled")) {
        cancelled = true;
        stopReason = `cancel requested${f.cancel_requested ? ` by ${f.cancel_requested.by.name || f.cancel_requested.by.id} (${f.cancel_requested.origin})` : ""}`;
      } else if (opts.signal?.aborted) stopReason = "worker stopping";
      return stopReason;
    };
    const onState = (s: JobState): void => {
      const q = queueStateOfRunner(s.state);
      if (!q || q === current) return;
      current = q;
      update(jobId, RUNNING_STATES, (x) => (x.state = q), null);
    };
    // M6 (CP-041 finding a): identify requests received while this job runs at each of its stage boundaries,
    // so their clarifying / merge / identified notices wait at most one stage instead of the whole job (§4.4).
    const atBoundary = async (): Promise<void> => {
      try {
        await intakeAll();
        deliverLocal();
      } catch (e) {
        appendWorkerLog(env, `boundary intake error (ignored; retried at the next boundary): ${e instanceof Error ? e.message : String(e)}`, now());
      }
    };
    st = await runJob(st, runnerDeps({ onState, shouldStop, atBoundary }));

    const finishCancelled = (where: string): JobStateName => {
      const prev = findJob(env, jobId)?.job.state;
      const j = update(jobId, [...RUNNING_STATES, "cancelled"], (x) => (x.state = "cancelled"), `cancelled ${where}`);
      if (j) notifyJob(env, j, "cancelled", `取消: ${jobId}「${titleOf(j)}」を取り消しました（${prev ?? "?"} の段の区切りで停止。途中までの成果は残っています）`, { previous_state: prev ?? null }, now());
      return "cancelled";
    };

    if (stopReason && st.state !== "done" && st.state !== "failed" && st.state !== "held") {
      if (cancelled) return finishCancelled(`at a stage boundary (${stopReason})`);
      update(jobId, RUNNING_STATES, (x) => (x.state = "queued"), `worker stopping: back to queued (resumable at the next unfinished stage)`);
      return "queued";
    }
    if (st.state === "failed") {
      const j = update(jobId, RUNNING_STATES, (x) => ((x.state = "failed"), (x.error = st.error)), `failed: ${st.error}`);
      if (j) notifyJob(env, j, "failed", `失敗: ${jobId}「${titleOf(j)}」は段の自動再試行（2回）でも回復しませんでした（${st.error ?? "?"}）`, { error: st.error }, now());
      return "failed";
    }
    if (st.state === "held") {
      const j = update(jobId, RUNNING_STATES, (x) => (x.state = "held"), `held: work ${st.work_id} was held after the job was received`);
      if (j) notifyJob(env, j, "held", `差し止め: ${jobId}「${titleOf(j)}」は作品 ${st.work_id} が差し止められたため停止しました（held）。途中までの成果は残っています`, { work_id: st.work_id }, now());
      return "held";
    }
    if (st.state !== "done") {
      const j = update(jobId, RUNNING_STATES, (x) => ((x.state = "failed"), (x.error = `runner ended in state ${st.state}`)), `runner ended in unexpected state ${st.state}`);
      if (j) notifyJob(env, j, "failed", `失敗: ${jobId}「${titleOf(j)}」が想定外の状態（${st.state}）で止まりました`, {}, now());
      return "failed";
    }
    if (shouldStop() && cancelled) return finishCancelled("before building");

    // building
    update(jobId, RUNNING_STATES, (x) => (x.state = "building"), "pipeline done; building the site");
    let lastErr = "";
    let built = false;
    for (let a = 1; a <= BUILD_ATTEMPTS && !built; a++) {
      jlog(jobId, `build start (attempt ${a}/${BUILD_ATTEMPTS}) → ${env.siteOut}`);
      try {
        const r = await build({ worksDir: env.worksDir, out: env.siteOut });
        jlog(jobId, `build done${r && typeof r === "object" ? ` ${JSON.stringify(r)}` : ""}`);
        built = true;
      } catch (e) {
        lastErr = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        jlog(jobId, `build error: ${lastErr}`);
      }
    }
    if (!built) {
      const j = update(jobId, ["building"], (x) => ((x.state = "failed"), (x.error = `build failed after ${BUILD_ATTEMPTS} attempts: ${lastErr}`)), `build failed after ${BUILD_ATTEMPTS} attempts`);
      if (j) notifyJob(env, j, "failed", `失敗: ${jobId}「${titleOf(j)}」のサイトビルドが${BUILD_ATTEMPTS}回失敗しました（${lastErr}）`, { stage: "building", error: lastErr }, now());
      return "failed";
    }
    let j = update(jobId, ["building"], (x) => ((x.state = "built"), (x.error = null)), `built (local preview: ${env.siteOut})`);
    let finalState: JobStateName = "built";
    let publishLine: string | null = null;
    let published: { ok: boolean; summary: string; release_id: string | null } | null = null;
    if (j && deps.publish && st.work_id && !isWorkRestricted(env.worksDir, st.work_id)) {
      jlog(jobId, "publish start (S6: production gate open, mode auto)");
      try {
        published = await deps.publish({ jobId, workId: st.work_id });
      } catch (e) {
        published = { ok: false, summary: (e instanceof Error ? e.message : String(e)).slice(0, 500), release_id: null };
      }
      jlog(jobId, `publish ${published.ok ? "done" : "FAILED"}: ${published.summary}`);
      if (published.ok) {
        j = update(jobId, ["built"], (x) => (x.state = "published"), `published (release ${published.release_id})`) ?? j;
        finalState = "published";
        publishLine = `公開しました（リリース ${published.release_id}）`;
      } else publishLine = `公開に失敗しました（ジョブは built のまま。sfsh publish で再試行できます）: ${published.summary}`;
    }
    if (j) {
      const s4 = completionNotice(env.worksDir, st);
      const text = [`完了: ${jobId}「${titleOf(j)}」（${st.work_id}）。ローカルプレビュー: ${env.siteOut}（sfsh preview）${j.restricted_notice_at ? "。※Restricted の作品のため公開されません" : ""}`, ...(publishLine ? [publishLine] : []), ...(s4 ? [s4] : [])].join("\n");
      notifyJob(env, j, "completed", text, { work_id: st.work_id, preview: env.siteOut, s4: s4 ?? null, publish: published }, now());
    }
    return finalState;
  };

  // ------------------------------------------------------------ 5. local delivery
  const deliverLocal = (): void => {
    for (const n of listPendingNotices(env)) {
      if (n.reply_to === null && !n.job_id && n.batch_id) {
        // Local batch notice (CLI / Muse batch): appended once to queue/batches/<id>/notices.log, then sent/.
        const bl = path.join(env.queueDir, "batches", n.batch_id, "notices.log");
        const seen = fs.existsSync(bl) && fs.readFileSync(bl, "utf8").includes(`notice ${n.id} `);
        if (!seen && fs.existsSync(path.dirname(bl))) fs.appendFileSync(bl, `${n.at} notice ${n.id} [${n.kind}] (local): ${n.text.replace(/\r?\n/g, " / ")}\n`, "utf8");
        markNoticeSent(env, n.id, "local", now());
        continue;
      }
      if (n.reply_to !== null || !n.job_id) continue;
      const logFile = path.join(env.jobsDir, `${n.job_id}.log`);
      const already = fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes(`notice ${n.id} `);
      if (!already) jlog(n.job_id, `notice ${n.id} [${n.kind}] (local): ${n.text}`);
      markNoticeSent(env, n.id, "local", now());
    }
  };

  // ------------------------------------------------------------ loop
  let stop = "";
  try {
    recover();
    for (;;) {
      if (opts.signal?.aborted) {
        stop = "signal";
        break;
      }
      const drops = adoptInboxDrops(env, now());
      for (const r of drops.rejected) appendWorkerLog(env, `inbox drop rejected: ${r.file}: ${r.errors.join("; ")}`, now());
      await intakeAll();
      deliverLocal();
      if (opts.maxJobs != null && summary.processed.length >= opts.maxJobs) {
        stop = "max-jobs";
        break;
      }
      if (opts.signal?.aborted) continue;
      const next = readyOrder(listJobs(env, ["ready"]).map((l) => l.job).filter((j) => j.state === "queued"))[0];
      if (next) {
        let state: JobStateName | null;
        try {
          state = await processMain(next.job_id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          jlog(next.job_id, `worker error: ${msg}`);
          const f = update(next.job_id, [...RUNNING_STATES, "queued"], (x) => ((x.state = "failed"), (x.error = `worker error: ${msg}`)), `worker error: ${msg}`);
          if (f) notifyJob(env, f, "failed", `失敗: ${f.job_id}「${titleOf(f)}」の処理中にエラー（${msg}）`, { error: msg }, now());
          state = "failed";
        }
        if (state) summary.processed.push({ job_id: next.job_id, state });
        deliverLocal();
        continue;
      }
      if (opts.once) {
        stop = "idle (once)";
        break;
      }
      await sleep(pollMs, opts.signal);
    }
  } finally {
    try {
      deliverLocal();
    } finally {
      appendWorkerLog(env, `worker stop (${stop || "error"}); processed ${summary.processed.map((p) => `${p.job_id}:${p.state}`).join(",") || "none"}`, now());
      lock.release();
    }
  }
  return summary;
}
