/**
 * AMENDMENT 09: re-run the S3/S4 stages `write` → `compose` → `autocheck` for one existing work, from the saved
 * research only (nkg/, gen/projection.json, research/claims.json, saved raw source text for the 30-char guard).
 *
 * - Reuses the job runner's stage functions (`offlineStage`) — no stage logic lives here.
 * - Network is impossible in this path: the fetcher throws, the budget allows 0 searches / 0 fetches, and both model
 *   ports are wrapped so that a request with model-side tools other than "none" (web search) is refused before the CLI
 *   is spawned. After the run the budget and fetcher counters are asserted to be 0.
 * - Refuses Restricted works, works without nkg/nkg.json or gen/projection.json, and works with a live job.
 * - Backs up the files the stages overwrite into works/<id>/gen/_backup-<stamp>/ before running (rollback = copy back).
 * - Per-work lock (logs/regen/<work_id>.lock) and a shared INDEX lock (logs/regen/index.lock) around `compose`
 *   (the only stage that writes a shared file, works/INDEX.json) plus a final INDEX rebuild, so regen processes for
 *   different works can run in parallel.
 * - Writes logs/regen/<work_id>.<stamp>.log (progress) and logs/regen/<work_id>.<stamp>.json (one-line record).
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import type { ModelPort, ModelRequest, ModelResult, PortName } from "../model/types.ts";
import { withDirLock } from "../publish/lock.ts";
import { pidAlive } from "../queue/lock.ts";
import type { BudgetState, Fetcher } from "../research/types.ts";
import { STAGING_PREFIX, readWork, rebuildIndex } from "../works/store.ts";
import { WRITE_PART_NAMES, type StageContext, type StageResult, type WritePartName } from "./context.ts";
import { MAX_ATTEMPTS, OFFLINE_STAGES, offlineStage, type OfflineStageName } from "./runner.ts";

export { OFFLINE_STAGES as REGEN_STAGES };
export type RegenStageName = OfflineStageName;

/** Files / dirs (relative to the work dir) that write / compose / autocheck overwrite — copied before the run. */
export const REGEN_BACKUP_ITEMS = [
  "gen/pages",
  "gen/public.json",
  "gen/write_report.json",
  "gen/synopsis_report.json",
  "gen/reviews",
  "gen/gen_check.json",
  "check",
  "work.json",
  "nkg/review_summary.json",
] as const;
export const BACKUP_PREFIX = "_backup-";

const WORK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A precondition failed: nothing was changed (CLI exit 2). */
export class RegenRefused extends Error {}

export interface RegenDeps {
  luna: ModelPort;
  haiku: ModelPort;
  worksDir: string;
  /** logs/regen — run log, record and lock dirs. */
  logDir: string;
  /** logs/jobs — checked for a live job on the same work. */
  jobsDir: string;
  now?: () => Date;
  maxAttempts?: number;
  /** Progress callback (CLI printing). */
  onStage?: (ev: { stage: RegenStageName; phase: "start" | "done" | "failed"; attempt: number; record?: RegenStageRecord }) => void;
}

export interface RegenOptions {
  stages?: readonly string[];
  /** AMENDMENT 11: S3 write parts (pages, synopsis). Absent = both. */
  parts?: readonly string[];
}

/** Parse / validate the --parts list for the write stage. */
export function parseWriteParts(list: readonly string[] | undefined): WritePartName[] | undefined {
  if (!list) return undefined;
  const want = list.map((s) => s.trim()).filter(Boolean);
  const bad = want.filter((s) => !(WRITE_PART_NAMES as readonly string[]).includes(s));
  if (bad.length) throw new RegenRefused(`unknown part(s) for regen: ${bad.join(", ")} (allowed: ${WRITE_PART_NAMES.join(", ")})`);
  if (!want.length) throw new RegenRefused("--parts is empty");
  return WRITE_PART_NAMES.filter((s) => want.includes(s));
}

export interface RegenStageRecord {
  stage: RegenStageName;
  status: "done" | "failed" | "skipped";
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  metrics: Record<string, number | string>;
  warnings: string[];
  error: string | null;
}

export interface ModelCallStats {
  total: number;
  by_port: Record<PortName, { ok: number; failed: number }>;
  by_task: Record<string, number>;
  refused_tools: number;
}

export interface RegenRecord {
  schema: "sfsh-regen/1";
  work_id: string;
  job_id: string;
  pid: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  stages_requested: RegenStageName[];
  /** AMENDMENT 11: write parts requested (absent = pages and synopsis). */
  parts_requested?: WritePartName[];
  stages: RegenStageRecord[];
  /** Relative to the work dir. */
  backup_dir: string;
  backup_items: string[];
  model_calls: ModelCallStats;
  network: { fetcher_calls: number; searches_used: number; fetches_used: number; budget_limits: BudgetState["limits"] };
  index_rebuilt: boolean;
  log_file: string;
  record_file: string;
  error: string | null;
}

/** Local timestamp for file names: YYYYMMDD-HHMMSSmmm. */
export function regenStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/** Parse / validate the --stages list: subset of write,compose,autocheck, run in the canonical order. */
export function parseRegenStages(list: readonly string[] | undefined): RegenStageName[] {
  if (!list) return [...OFFLINE_STAGES];
  const want = list.map((s) => s.trim()).filter(Boolean);
  const bad = want.filter((s) => !(OFFLINE_STAGES as readonly string[]).includes(s));
  if (bad.length) throw new RegenRefused(`unknown stage(s) for regen: ${bad.join(", ")} (allowed: ${OFFLINE_STAGES.join(", ")})`);
  if (!want.length) throw new RegenRefused("--stages is empty");
  return OFFLINE_STAGES.filter((s) => want.includes(s));
}

/** Checks done before anything is written. Throws RegenRefused. */
export function regenPreflight(worksDir: string, jobsDir: string, workId: string): string {
  if (!WORK_ID_RE.test(workId) || workId.startsWith(STAGING_PREFIX)) throw new RegenRefused(`invalid work_id: ${JSON.stringify(workId)}`);
  const workDir = path.join(worksDir, workId);
  if (!fs.existsSync(path.join(workDir, "work.json"))) throw new RegenRefused(`work not found: ${workId} (no works/${workId}/work.json)`);
  const w = readWork(workDir);
  if (w.publish_mode === "Restricted") throw new RegenRefused(`work ${workId} is Restricted (held / taken down) — regen refused; release it first`);
  for (const rel of ["nkg/nkg.json", "gen/projection.json"]) if (!fs.existsSync(path.join(workDir, rel))) throw new RegenRefused(`work ${workId} has no ${rel} — regen re-uses saved research only (run the full job instead)`);
  const live = liveJobFor(jobsDir, workId);
  if (live) throw new RegenRefused(`work ${workId} has a running job ${live} — wait for it to finish`);
  return workDir;
}

function liveJobFor(jobsDir: string, workId: string): string | null {
  if (!fs.existsSync(jobsDir)) return null;
  for (const f of fs.readdirSync(jobsDir)) {
    if (!f.endsWith(".state.json")) continue;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(jobsDir, f), "utf8")) as { job_id?: string; work_id?: string | null; pid?: number | null; state?: string };
      if (st.work_id === workId && typeof st.pid === "number" && st.pid !== process.pid && pidAlive(st.pid) && st.state !== "done" && st.state !== "failed") return st.job_id ?? f;
    } catch {
      /* unreadable state file: not a live job we can identify */
    }
  }
  return null;
}

/** Copy the files the stages overwrite into gen/_backup-<stamp>/ (mirroring paths relative to the work dir). */
export function backupWork(workDir: string, stamp: string, meta: Record<string, unknown>): { dir: string; items: string[] } {
  let rel = `gen/${BACKUP_PREFIX}${stamp}`;
  for (let k = 2; fs.existsSync(path.join(workDir, rel)); k++) rel = `gen/${BACKUP_PREFIX}${stamp}-${k}`;
  const abs = path.join(workDir, rel);
  fs.mkdirSync(abs, { recursive: true });
  const items: string[] = [];
  const missing: string[] = [];
  for (const item of REGEN_BACKUP_ITEMS) {
    const src = path.join(workDir, item);
    if (!fs.existsSync(src)) {
      missing.push(item);
      continue;
    }
    fs.cpSync(src, path.join(abs, item), { recursive: true, errorOnExist: false });
    items.push(item);
  }
  fs.writeFileSync(
    path.join(abs, "manifest.json"),
    JSON.stringify({ schema: "sfsh-regen-backup/1", ...meta, items, missing, restore: "copy each item back to works/<work_id>/<item> (paths mirror the work dir)" }, null, 2) + "\n",
    "utf8",
  );
  return { dir: rel, items };
}

/** Fetcher that can never reach the network (S3/S4 do not fetch; any call is a bug). */
export function noNetworkFetcher(counter: { calls: number }): Fetcher {
  return {
    fetchAll: async () => {
      counter.calls++;
      throw new Error("regen: network fetch is disabled (S3/S4 re-run uses saved research only)");
    },
  };
}

/** Wrap a model port: refuse model-side tools (web search), count calls. */
export function offlinePort(inner: ModelPort, stats: ModelCallStats): ModelPort {
  return {
    port: inner.port,
    modelId: inner.modelId,
    async call(req: ModelRequest): Promise<ModelResult> {
      if (req.tools && req.tools !== "none") {
        stats.refused_tools++;
        throw new Error(`regen: model tools "${req.tools}" are disabled (no web search in regen) — task ${req.task}`);
      }
      stats.total++;
      stats.by_task[req.task] = (stats.by_task[req.task] ?? 0) + 1;
      try {
        const r = await inner.call({ ...req, tools: "none" });
        stats.by_port[inner.port].ok++;
        return r;
      } catch (e) {
        stats.by_port[inner.port].failed++;
        throw e;
      }
    },
  };
}

async function tryWorkLock<T>(lockDir: string, workId: string, fn: () => Promise<T>): Promise<T> {
  let entered = false;
  try {
    return await withDirLock(
      lockDir,
      () => {
        entered = true;
        return fn();
      },
      0,
    );
  } catch (e) {
    if (!entered) throw new RegenRefused(`another regen of ${workId} is running (lock ${lockDir}): ${(e as Error).message}`);
    throw e;
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export async function runRegen(workId: string, opts: RegenOptions, deps: RegenDeps): Promise<RegenRecord> {
  const now = deps.now ?? (() => new Date());
  const stages = parseRegenStages(opts.stages);
  const parts = parseWriteParts(opts.parts);
  regenPreflight(deps.worksDir, deps.jobsDir, workId);
  fs.mkdirSync(deps.logDir, { recursive: true });
  return tryWorkLock(path.join(deps.logDir, `${workId}.lock`), workId, async () => {
    const workDir = regenPreflight(deps.worksDir, deps.jobsDir, workId); // re-check under the lock
    const t0 = Date.now();
    const startedAt = now();
    let stamp = regenStamp(startedAt);
    for (let k = 2; fs.existsSync(path.join(deps.logDir, `${workId}.${stamp}.json`)) || fs.existsSync(path.join(workDir, "gen", `${BACKUP_PREFIX}${stamp}`)); k++) stamp = `${regenStamp(startedAt)}-${k}`;
    const jobId = `regen-${stamp}-${workId}`;
    const logFile = path.join(deps.logDir, `${workId}.${stamp}.log`);
    const recordFile = path.join(deps.logDir, `${workId}.${stamp}.json`);
    const log = (m: string) => fs.appendFileSync(logFile, `${isoLocal(now())} ${m}\n`, "utf8");
    log(`regen start pid=${process.pid} work=${workId} stages=${stages.join(",")}${parts ? ` parts=${parts.join(",")}` : ""} job_id=${jobId}`);

    const backup = backupWork(workDir, stamp, { work_id: workId, job_id: jobId, created_at: isoLocal(startedAt), stages });
    log(`backup ${backup.dir}: ${backup.items.join(", ") || "(nothing to back up)"}`);

    const stats: ModelCallStats = { total: 0, by_port: { haiku: { ok: 0, failed: 0 }, luna: { ok: 0, failed: 0 } }, by_task: {}, refused_tools: 0 };
    const fetchCounter = { calls: 0 };
    const budget: BudgetState = { limits: { searches: 0, fetches: 0, wallMs: 0 }, searchesUsed: 0, fetchesUsed: 0, startedAt: isoLocal(startedAt) };
    const ctx: StageContext = {
      jobId,
      workDir,
      workId,
      range: [{ unit: "whole", from: null, to: null, label: "全体" }],
      luna: offlinePort(deps.luna, stats),
      haiku: offlinePort(deps.haiku, stats),
      fetcher: noNetworkFetcher(fetchCounter),
      budget,
      now,
      log,
      ...(parts ? { writeParts: parts } : {}),
    };
    const indexLock = path.join(deps.logDir, "index.lock");
    const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
    const records: RegenStageRecord[] = OFFLINE_STAGES.map((s) => ({
      stage: s,
      status: "skipped",
      attempts: 0,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      metrics: {},
      warnings: [],
      error: null,
    }));
    let error: string | null = null;
    let indexRebuilt = false;
    try {
      for (const name of stages) {
        const rec = records.find((r) => r.stage === name)!;
        const base = offlineStage(name);
        // compose rewrites works/INDEX.json from every work.json: serialize it across regen processes.
        const fn = name === "compose" ? (c: StageContext) => withDirLock(indexLock, () => base(c), 5 * 60_000) : base;
        let ok = false;
        while (rec.attempts < maxAttempts && !ok) {
          rec.attempts++;
          rec.started_at = isoLocal(now());
          rec.error = null;
          deps.onStage?.({ stage: name, phase: "start", attempt: rec.attempts });
          log(`stage ${name} start (attempt ${rec.attempts}/${maxAttempts})`);
          const s0 = Date.now();
          try {
            const r: StageResult = await fn(ctx);
            rec.metrics = r.metrics;
            rec.warnings = r.warnings.slice(0, 50);
            rec.status = "done";
            ok = true;
          } catch (e) {
            rec.error = errMsg(e);
            rec.status = "failed";
            log(`stage ${name} error: ${rec.error}`);
          }
          rec.finished_at = isoLocal(now());
          rec.duration_ms = Date.now() - s0;
          if (ok) log(`stage ${name} done in ${Math.round(rec.duration_ms / 1000)}s ${JSON.stringify(rec.metrics)}`);
          deps.onStage?.({ stage: name, phase: ok ? "done" : "failed", attempt: rec.attempts, record: rec });
        }
        if (!ok) {
          error = `stage ${name} failed after ${rec.attempts} attempt(s): ${rec.error}`;
          break;
        }
      }
    } finally {
      // Final INDEX rebuild under the shared lock: the last regen to finish sees every work.json (compose and
      // autocheck of parallel regens may have written theirs after an earlier rebuild).
      try {
        await withDirLock(indexLock, async () => rebuildIndex(deps.worksDir), 5 * 60_000);
        indexRebuilt = true;
      } catch (e) {
        log(`index rebuild failed: ${errMsg(e)}`);
      }
    }
    if (fetchCounter.calls || budget.searchesUsed || budget.fetchesUsed || stats.refused_tools) {
      const net = `network use detected (fetcher calls ${fetchCounter.calls}, searches ${budget.searchesUsed}, fetches ${budget.fetchesUsed}, refused tool requests ${stats.refused_tools})`;
      error = error ? `${error}; ${net}` : net;
    }
    const record: RegenRecord = {
      schema: "sfsh-regen/1",
      work_id: workId,
      job_id: jobId,
      pid: process.pid,
      started_at: isoLocal(startedAt),
      finished_at: isoLocal(now()),
      duration_ms: Date.now() - t0,
      ok: error === null,
      stages_requested: stages,
      ...(parts ? { parts_requested: parts } : {}),
      stages: records.filter((r) => stages.includes(r.stage)),
      backup_dir: backup.dir,
      backup_items: backup.items,
      model_calls: stats,
      network: { fetcher_calls: fetchCounter.calls, searches_used: budget.searchesUsed, fetches_used: budget.fetchesUsed, budget_limits: budget.limits },
      index_rebuilt: indexRebuilt,
      log_file: logFile,
      record_file: recordFile,
      error,
    };
    fs.writeFileSync(recordFile, JSON.stringify(record) + "\n", "utf8");
    log(`regen end ok=${record.ok}${error ? ` error=${error}` : ""} model_calls=${stats.total}`);
    return record;
  });
}
