/**
 * Queue file store (§4.4, WP-4.2). One job = one JSON file in exactly one of queue/<dir>/.
 *
 * Crash safety:
 *  - content change: write `<file>.<pid>.tmp` in the SAME directory, then rename over the file (atomic);
 *  - directory change: one fs.renameSync after the content change. A crash in between leaves the file in the old
 *    directory with the new state; reconcileDirs() (run by the worker at start-up) moves it where its state says.
 *  - job ids are reserved by creating logs/jobs/<job_id>.log with O_EXCL (CLI, bot and worker may allocate concurrently).
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import { paths } from "../paths.ts";
import { DIR_OF_STATE, QUEUE_DIRS, type JobRequest, type QueueDir } from "./types.ts";

export interface QueueEnv {
  /** queue/ */
  queueDir: string;
  /** logs/jobs/ (transition logs <job_id>.log, runner checkpoints <job_id>.state.json) */
  jobsDir: string;
  /** works/ */
  worksDir: string;
  /** logs/LEDGER.md (ops lines) */
  ledgerPath: string;
  /** site output for the building stage (site/dist) */
  siteOut: string;
}

export function defaultQueueEnv(): QueueEnv {
  return {
    queueDir: paths.queue,
    jobsDir: paths.jobLogDir,
    worksDir: paths.works,
    ledgerPath: path.join(paths.root, "logs", "LEDGER.md"),
    siteOut: path.join(paths.root, "site", "dist"),
  };
}

export const JOB_ID_RE = /^\d{8}-\d{4}$/;

export function ensureQueueDirs(env: QueueEnv): void {
  for (const d of QUEUE_DIRS) fs.mkdirSync(path.join(env.queueDir, d), { recursive: true });
  fs.mkdirSync(path.join(env.queueDir, "batches"), { recursive: true });
  fs.mkdirSync(path.join(env.queueDir, "outbox", "pending"), { recursive: true });
  fs.mkdirSync(path.join(env.queueDir, "outbox", "sent"), { recursive: true });
  fs.mkdirSync(env.jobsDir, { recursive: true });
}

export function jobFile(env: QueueEnv, dir: QueueDir, jobId: string): string {
  return path.join(env.queueDir, dir, `${jobId}.json`);
}

export interface JobLocation {
  dir: QueueDir;
  file: string;
  job: JobRequest;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
}

/** Find a job by id in any queue directory. When (after a crash) two copies exist, the newer updated_at wins. */
export function findJob(env: QueueEnv, jobId: string): JobLocation | null {
  let best: JobLocation | null = null;
  for (const dir of QUEUE_DIRS) {
    const file = jobFile(env, dir, jobId);
    if (!fs.existsSync(file)) continue;
    let job: JobRequest;
    try {
      job = readJson<JobRequest>(file);
    } catch {
      continue;
    }
    if (!best || Date.parse(job.updated_at) > Date.parse(best.job.updated_at)) best = { dir, file, job };
  }
  return best;
}

export function readJob(env: QueueEnv, jobId: string): JobRequest {
  const loc = findJob(env, jobId);
  if (!loc) throw new Error(`unknown job_id: ${jobId}`);
  return loc.job;
}

/** All jobs (optionally only some directories). Files that are not `<job_id>.json` or not JSON are skipped. */
export function listJobs(env: QueueEnv, dirs: readonly QueueDir[] = QUEUE_DIRS): JobLocation[] {
  const out: JobLocation[] = [];
  for (const dir of dirs) {
    const d = path.join(env.queueDir, dir);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d).sort()) {
      const m = name.match(/^(\d{8}-\d{4})\.json$/);
      if (!m) continue;
      const file = path.join(d, name);
      try {
        out.push({ dir, file, job: readJson<JobRequest>(file) });
      } catch {
        /* half-written or foreign file: ignored here; the worker reports it */
      }
    }
  }
  return out;
}

export function appendJobLog(env: QueueEnv, jobId: string, msg: string, now: Date = new Date()): void {
  fs.mkdirSync(env.jobsDir, { recursive: true });
  fs.appendFileSync(path.join(env.jobsDir, `${jobId}.log`), `${isoLocal(now)} ${msg.replace(/\r?\n/g, " / ")}\n`, "utf8");
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Persist a job: content first (in place), then move to the directory of its state. Appends one transition line
 * to logs/jobs/<job_id>.log when the state or directory changed (or `note` is given).
 */
export function saveJob(env: QueueEnv, job: JobRequest, note: string | null = null, now: Date = new Date()): JobLocation {
  const loc = findJob(env, job.job_id);
  const prevState = loc?.job.state ?? null;
  const prevDir = loc?.dir ?? null;
  const target = DIR_OF_STATE[job.state];
  job.updated_at = isoLocal(now);
  let file: string;
  if (loc) {
    writeAtomic(loc.file, job);
    file = loc.file;
    if (loc.dir !== target) {
      const dest = jobFile(env, target, job.job_id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(loc.file, dest);
      file = dest;
    }
  } else {
    file = jobFile(env, target, job.job_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, job);
  }
  if (prevState !== job.state || prevDir !== target || note) {
    const t = prevState === null ? `state ${job.state} (${target}/)` : prevState === job.state && prevDir === target ? `state ${job.state}` : `state ${prevState} -> ${job.state} (${prevDir}/ -> ${target}/)`;
    appendJobLog(env, job.job_id, `queue: ${t}${note ? ` — ${note}` : ""}`, now);
  }
  return { dir: target, file, job };
}

/** Move every job file whose directory disagrees with its state (crash between content write and rename), and drop stale duplicates. */
export function reconcileDirs(env: QueueEnv, now: Date = new Date()): string[] {
  const moved: string[] = [];
  const byId = new Map<string, JobLocation[]>();
  for (const l of listJobs(env)) byId.set(l.job.job_id, [...(byId.get(l.job.job_id) ?? []), l]);
  for (const [id, locs] of byId) {
    locs.sort((a, b) => Date.parse(b.job.updated_at) - Date.parse(a.job.updated_at));
    const [keep, ...stale] = locs;
    for (const s of stale) {
      fs.rmSync(s.file, { force: true });
      appendJobLog(env, id, `queue: removed stale duplicate ${s.dir}/${id}.json (kept ${keep!.dir}/)`, now);
      moved.push(`${id}: stale ${s.dir}`);
    }
    const target = DIR_OF_STATE[keep!.job.state];
    if (keep!.dir !== target) {
      fs.renameSync(keep!.file, jobFile(env, target, id));
      appendJobLog(env, id, `queue: reconciled ${keep!.dir}/ -> ${target}/ (state ${keep!.job.state})`, now);
      moved.push(`${id}: ${keep!.dir} -> ${target}`);
    }
  }
  // leftover tmp files of dead writers
  for (const dir of QUEUE_DIRS) {
    const d = path.join(env.queueDir, dir);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) if (/\.\d+\.tmp$/.test(name)) fs.rmSync(path.join(d, name), { force: true });
  }
  return moved;
}

function dayOf(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** Highest NNNN used today in logs/jobs (log / state files) and every queue directory. */
function maxSeq(env: QueueEnv, day: string): number {
  let max = 0;
  const re = new RegExp(`^${day}-(\\d{4})(?:\\.|$)`);
  const scan = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const m = f.match(re);
      if (m) max = Math.max(max, Number(m[1]));
    }
  };
  scan(env.jobsDir);
  for (const dir of QUEUE_DIRS) scan(path.join(env.queueDir, dir));
  return max;
}

/** Reserve the next job id `YYYYMMDD-NNNN` (§4.1) by creating logs/jobs/<id>.log exclusively. */
export function allocateJobId(env: QueueEnv, now: Date = new Date()): string {
  fs.mkdirSync(env.jobsDir, { recursive: true });
  const day = dayOf(now);
  let n = maxSeq(env, day) + 1;
  for (let tries = 0; tries < 10_000; tries++, n++) {
    if (n > 9999) throw new Error(`job id space exhausted for ${day}`);
    const id = `${day}-${String(n).padStart(4, "0")}`;
    try {
      fs.writeFileSync(path.join(env.jobsDir, `${id}.log`), `${isoLocal(now)} job id reserved\n`, { encoding: "utf8", flag: "wx" });
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("could not allocate a job id");
}
