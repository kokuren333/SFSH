/**
 * Owner operations on a work (REQUIREMENTS §5.3 / §5.4, WP-3.3): hold, release, and the LOCAL parts of takedown / purge.
 *
 * - hold:     publish_mode → Restricted, history[], INDEX.json, ledger line, unfinished jobs of the work → `held`
 *             (only when no live process owns them; a running job is held by the runner at its next stage boundary).
 * - release:  publish_mode → Public, history[], INDEX.json, ledger line. Held jobs are only reported (`sfsh job resume`).
 * - takedown: hold + rebuild the site without the work + verify that dist/ holds no trace of it, then (M5, WP-5.3)
 *             the injected publish hook: push-pre verification → snapshot push → post-push check → 404 check.
 *             Without a hook (publish/ not initialized) the push is recorded as not run.
 * - purge:    takedown + delete the work's gen/, releases/ and check/ (research/, nkg/, work.json and ledger records are kept).
 *
 * The ledger (logs/LEDGER.md) is only ever appended to, one `- OPS …` line per operation.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isoLocal } from "../model/callLog.ts";
import { readIndex, readWork, rebuildIndex, workDirOf, workExists, writeJsonAtomic, writeWork } from "./store.ts";
import type { Work, WorkHistoryEntry } from "./types.ts";
import { releaseConformanceHold } from "../check/conformance.ts";

export const DEFAULT_ACTOR = "owner(cli)";
/** takedown / purge without a publish target (publish/ not initialized → nothing has been pushed anywhere). */
export const PUSH_PENDING = "not run: no publish target (publish/ is not initialized; the site is not opened)";
export const URL_404_PENDING = "not run: no publish target";

/** Job states after which hold leaves the job alone. */
export const TERMINAL_JOB_STATES = ["done", "failed", "cancelled", "held"] as const;

export type OpsEvent = "hold" | "release" | "takedown" | "purge";

export interface OpsOptions {
  worksDir: string;
  workId: string;
  reason?: string;
  /** Who ran the operation. Default "owner(cli)" (the local CLI runner is treated as the owner, §4.4). */
  actor?: string;
  now?: () => Date;
  /** logs/jobs (job state files <job_id>.state.json and logs <job_id>.log). */
  jobsDir: string;
  /** logs/LEDGER.md (append only). */
  ledgerPath: string;
}

export interface BuildLike {
  (options: { worksDir?: string; out?: string; baseUrl?: string }): Promise<unknown>;
}

export interface TakedownOptions extends OpsOptions {
  /** Site output directory to rebuild and verify (CLI default site/dist). Required unless `build` writes elsewhere. */
  buildOut?: string;
  /** Passed to build() so sitemap.xml is produced and verified too. */
  baseUrl?: string;
  /** Injectable build (tests). Default: harness/src/site/build.ts build(). */
  build?: BuildLike;
  /** M5: push side (sfsh publish with the takedown context). Absent → push recorded as not run. */
  publish?: TakedownPublishHook;
}

export interface TakedownPublishOutcome {
  ok: boolean;
  /** One-line description of the push (recorded in history / ledger). */
  push: string;
  url_404_check: string;
  release_id: string | null;
  /** Full publish result (for --json). */
  detail?: unknown;
}

export type TakedownPublishHook = (ctx: { workId: string; needles: string[]; event: "takedown" | "purge"; reason: string | null; actor: string }) => Promise<TakedownPublishOutcome>;

export interface JobOpReport {
  job_id: string;
  previous_state: string;
  pid: number | null;
  /**
   * held:            state file set to `held` (no live process owned the job).
   * running:         a live process owns the job; file untouched — the runner holds it at the next stage boundary.
   * held_waiting:    (release) the job is `held`; continue it with `sfsh job resume <job_id>`.
   */
  action: "held" | "running" | "held_waiting";
}

export interface OpsResult {
  event: OpsEvent;
  work_id: string;
  actor: string;
  reason: string | null;
  previous_publish_mode: Work["publish_mode"];
  publish_mode: Work["publish_mode"];
  /** The work was already in the target mode (the operation is still recorded). */
  no_change: boolean;
  history_entry: WorkHistoryEntry;
  ledger_line: string;
  jobs: JobOpReport[];
  elapsed_ms: number;
}

export interface DistTrace {
  file: string;
  needle: string;
}

export interface TakedownResult extends OpsResult {
  build: { out: string; summary: unknown; elapsed_ms: number };
  verification: { dist: string; needles: string[]; skipped_needles: string[]; files_scanned: number; traces: DistTrace[] };
  push: string;
  url_404_check: string;
  /** M5: the publish run of this takedown (null when no publish target). */
  publish: { release_id: string | null; ok: boolean; detail?: unknown } | null;
}

export interface PurgeResult extends TakedownResult {
  /** Directories removed, relative to the work dir (only those that existed). */
  deleted: string[];
  /** Entries left in the work dir (evidence: research/, nkg/, work.json, …). */
  kept: string[];
}

export class TakedownVerificationError extends Error {
  readonly result: TakedownResult;
  constructor(message: string, result: TakedownResult) {
    super(message);
    this.name = "TakedownVerificationError";
    this.result = result;
  }
}

export class UnknownWorkError extends Error {
  constructor(workId: string) {
    super(`unknown work_id: ${workId}`);
    this.name = "UnknownWorkError";
  }
}

// ---------- shared helpers ----------

/** True when works/<id>/work.json says Restricted. False when the work does not exist (for the runner's stage check). */
export function isWorkRestricted(worksDir: string, workId: string): boolean {
  const f = path.join(worksDir, workId, "work.json");
  if (!fs.existsSync(f)) return false;
  return (JSON.parse(fs.readFileSync(f, "utf8")) as Work).publish_mode === "Restricted";
}

function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Append one raw line to the ledger, making sure it starts on a new line. Never rewrites the file. */
export function appendRawLedgerLine(ledgerPath: string, line: string): string {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  let prefix = "";
  try {
    const st = fs.statSync(ledgerPath);
    if (st.size > 0) {
      const fd = fs.openSync(ledgerPath, "r");
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.appendFileSync(ledgerPath, `${prefix}${line}\n`, "utf8");
  return line;
}

/** Append one `- OPS …` line to the ledger, making sure it starts on a new line. Never rewrites the file. */
export function appendLedgerLine(ledgerPath: string, at: Date, event: string, workId: string, actor: string, reason: string | null, detail: string): string {
  const line = `- OPS ${isoLocal(at)} | ${event} | work=${workId} | actor=${oneLine(actor, 80)} | reason=${reason ? oneLine(reason, 200) : "-"} | ${oneLine(detail)}`;
  return appendRawLedgerLine(ledgerPath, line);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LooseJobState {
  job_id?: string;
  work_id?: string | null;
  state?: string;
  pid?: number | null;
  updated_at?: string;
  [k: string]: unknown;
}

function jobStatesOf(jobsDir: string, workId: string): { file: string; st: LooseJobState }[] {
  if (!fs.existsSync(jobsDir)) return [];
  const out: { file: string; st: LooseJobState }[] = [];
  for (const name of fs.readdirSync(jobsDir).sort()) {
    if (!name.endsWith(".state.json")) continue;
    const file = path.join(jobsDir, name);
    let st: LooseJobState;
    try {
      st = JSON.parse(fs.readFileSync(file, "utf8")) as LooseJobState;
    } catch {
      continue; // half-written or foreign file: not ours to judge here
    }
    if (st.work_id === workId) out.push({ file, st });
  }
  return out;
}

function appendJobLog(jobsDir: string, jobId: string, at: Date, msg: string): void {
  fs.appendFileSync(path.join(jobsDir, `${jobId}.log`), `${isoLocal(at)} ${msg}\n`, "utf8");
}

/** §5.4 hold: unfinished jobs of the work → `held` unless a live process owns them. */
function holdJobs(jobsDir: string, workId: string, at: Date, event: OpsEvent, actor: string, reason: string | null): JobOpReport[] {
  const reports: JobOpReport[] = [];
  for (const { file, st } of jobStatesOf(jobsDir, workId)) {
    const state = String(st.state ?? "");
    if ((TERMINAL_JOB_STATES as readonly string[]).includes(state)) continue;
    const jobId = st.job_id ?? path.basename(file, ".state.json");
    const pid = typeof st.pid === "number" ? st.pid : null;
    if (pid !== null && pidAlive(pid)) {
      reports.push({ job_id: jobId, previous_state: state, pid, action: "running" });
      continue;
    }
    st.state = "held";
    st.pid = null;
    st.updated_at = isoLocal(at);
    writeJsonAtomic(file, st);
    appendJobLog(jobsDir, jobId, at, `job held by ${event} (actor=${actor}${reason ? `, reason=${oneLine(reason, 200)}` : ""}; was ${state}${pid !== null ? `, stale pid ${pid}` : ""}). Continue with: sfsh job resume ${jobId}`);
    reports.push({ job_id: jobId, previous_state: state, pid, action: "held" });
  }
  return reports;
}

function heldJobs(jobsDir: string, workId: string): JobOpReport[] {
  return jobStatesOf(jobsDir, workId)
    .filter(({ st }) => st.state === "held")
    .map(({ file, st }) => ({ job_id: st.job_id ?? path.basename(file, ".state.json"), previous_state: "held", pid: null, action: "held_waiting" as const }));
}

function loadWork(worksDir: string, workId: string): { dir: string; work: Work } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(workId) || !workExists(worksDir, workId)) throw new UnknownWorkError(workId);
  const dir = workDirOf(worksDir, workId);
  return { dir, work: readWork(dir) };
}

function setMode(dir: string, work: Work, mode: Work["publish_mode"], entry: WorkHistoryEntry): void {
  work.publish_mode = mode;
  (work.history ??= []).push(entry);
  writeWork(dir, work);
}

function historyEntry(at: Date, event: string, actor: string, reason: string | null, detail: string): WorkHistoryEntry {
  const e: WorkHistoryEntry = { at: isoLocal(at), event, job_id: null, actor };
  if (reason) e.reason = reason;
  e.detail = detail;
  return e;
}

function jobSummary(jobs: JobOpReport[]): string {
  const held = jobs.filter((j) => j.action === "held").map((j) => j.job_id);
  const running = jobs.filter((j) => j.action === "running").map((j) => j.job_id);
  const waiting = jobs.filter((j) => j.action === "held_waiting").map((j) => j.job_id);
  const parts: string[] = [];
  if (held.length) parts.push(`jobs held: ${held.join(",")}`);
  if (running.length) parts.push(`running jobs (held at next stage boundary): ${running.join(",")}`);
  if (waiting.length) parts.push(`held jobs (resume with sfsh job resume): ${waiting.join(",")}`);
  return parts.length ? parts.join("; ") : "no unfinished jobs";
}

// ---------- hold / release ----------

export function holdWork(opts: OpsOptions): OpsResult {
  const t0 = performance.now();
  const now = opts.now ?? (() => new Date());
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const reason = opts.reason?.trim() || null;
  const { dir, work } = loadWork(opts.worksDir, opts.workId);
  const at = now();
  const prev = work.publish_mode;
  const jobs = holdJobs(opts.jobsDir, opts.workId, at, "hold", actor, reason);
  const detail = `${prev === "Restricted" ? "already Restricted (hold re-recorded)" : "Public -> Restricted"}; excluded from the next build; ${jobSummary(jobs)}`;
  const entry = historyEntry(at, "hold", actor, reason, detail);
  setMode(dir, work, "Restricted", entry);
  rebuildIndex(opts.worksDir);
  const line = appendLedgerLine(opts.ledgerPath, at, "hold", opts.workId, actor, reason, detail);
  return { event: "hold", work_id: opts.workId, actor, reason, previous_publish_mode: prev, publish_mode: "Restricted", no_change: prev === "Restricted", history_entry: entry, ledger_line: line, jobs, elapsed_ms: performance.now() - t0 };
}

export function releaseWork(opts: OpsOptions): OpsResult {
  const t0 = performance.now();
  const now = opts.now ?? (() => new Date());
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const reason = opts.reason?.trim() || null;
  const { dir } = loadWork(opts.worksDir, opts.workId);
  const at = now();
  // AMENDMENT 15: a conformance hold ("built, publish held") is released by the same command: the held candidate
  // (gen/public.held.json) becomes gen/public.json and goes out with the next publish.
  const conf = releaseConformanceHold(dir, actor, reason, at);
  const work = readWork(dir);
  const prev = work.publish_mode;
  const jobs = heldJobs(opts.jobsDir, opts.workId);
  const detail = `${prev === "Public" ? (conf.released ? "Public" : "already Public (release re-recorded)") : "Restricted -> Public"}; ${conf.released ? `${conf.detail}; ` : ""}published by the next build; ${jobSummary(jobs)}`;
  const entry = historyEntry(at, "release", actor, reason, detail);
  setMode(dir, work, "Public", entry);
  rebuildIndex(opts.worksDir);
  const line = appendLedgerLine(opts.ledgerPath, at, "release", opts.workId, actor, reason, detail);
  return { event: "release", work_id: opts.workId, actor, reason, previous_publish_mode: prev, publish_mode: "Public", no_change: prev === "Public", history_entry: entry, ledger_line: line, jobs, elapsed_ms: performance.now() - t0 };
}

// ---------- dist verification ----------

const BINARY_EXT = new Set([".woff2", ".woff", ".ico", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".mp3", ".mp4", ".wasm"]);

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function decodeJsonEscapes(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["\\/])/g, "$1");
}

function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

function listAll(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listAll(root, p));
    else out.push(p);
  }
  return out.sort();
}

/**
 * Every (file, needle) pair where `needle` occurs in a file under `distDir`.
 * Both sides are NFKC-normalized and lower-cased; file text is also checked after decoding HTML entities and
 * JSON \\u escapes. Binary font/icon files are skipped. Empty needles are ignored.
 */
export function distTraces(distDir: string, needles: string[]): DistTrace[] {
  const ns = [...new Set(needles.map((n) => n.trim()).filter((n) => n.length > 0))];
  const traces: DistTrace[] = [];
  for (const file of listAll(distDir)) {
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
    const raw = fs.readFileSync(path.join(distDir, file), "utf8");
    const forms = [norm(raw), norm(decodeEntities(raw)), norm(decodeJsonEscapes(raw))];
    for (const n of ns) {
      const nn = norm(n);
      if (forms.some((f) => f.includes(nn))) traces.push({ file, needle: n });
    }
  }
  return traces;
}

/** Identifying strings of a work: work_id, title, title_original, every alias text (work.json, INDEX, gen/public.json). */
export function workNeedles(worksDir: string, workId: string): string[] {
  const set = new Set<string>([workId]);
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) set.add(v.trim());
  };
  const dir = workDirOf(worksDir, workId);
  const w = readWork(dir);
  add(w.title);
  add(w.title_original);
  for (const a of w.aliases ?? []) add(a.text);
  try {
    const entry = readIndex(worksDir).works.find((e) => e.work_id === workId);
    if (entry) {
      add(entry.title);
      add(entry.title_original);
      for (const a of entry.aliases ?? []) add(a.text);
    }
  } catch {
    /* INDEX unreadable: work.json is authoritative */
  }
  const pub = path.join(dir, "gen", "public.json");
  if (fs.existsSync(pub)) {
    const p = JSON.parse(fs.readFileSync(pub, "utf8")) as { work?: { work_id?: unknown; title?: unknown; title_original?: unknown; aliases_display?: unknown[] } };
    add(p.work?.title);
    add(p.work?.title_original);
    for (const a of p.work?.aliases_display ?? []) add(a);
  }
  return [...set];
}

/** Needles shorter than this (after NFKC) are reported as skipped, not searched (they would match unrelated text). */
export const MIN_NEEDLE_CHARS = 2;

// ---------- takedown / purge (local part) ----------

async function takedownCore(opts: TakedownOptions, event: "takedown" | "purge"): Promise<PurgeResult> {
  const t0 = performance.now();
  const now = opts.now ?? (() => new Date());
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const reason = opts.reason?.trim() || null;
  const { dir, work } = loadWork(opts.worksDir, opts.workId);
  const at = now();
  const prev = work.publish_mode;
  // Needles first: purge deletes gen/public.json before the rebuild.
  const all = workNeedles(opts.worksDir, opts.workId);
  const needles = all.filter((n) => n.normalize("NFKC").trim().length >= MIN_NEEDLE_CHARS);
  const skipped = all.filter((n) => !needles.includes(n));

  // 1) Restricted now (recorded before the slow part, so a crash during the build still leaves the work excluded).
  const jobs = holdJobs(opts.jobsDir, opts.workId, at, event, actor, reason);
  const entry = historyEntry(at, event, actor, reason, `${prev} -> Restricted; local rebuild and verification started`);
  setMode(dir, work, "Restricted", entry);
  rebuildIndex(opts.worksDir);

  // 2) purge: remove gen/ and releases/ (5.4) and check/ (S4's pre-fix copy of generated text, CP-032);
  //    research/, nkg/, work.json stay as evidence.
  const deleted: string[] = [];
  if (event === "purge") {
    for (const sub of ["gen", "releases", "check"]) {
      const p = path.join(dir, sub);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        deleted.push(`${sub}/`);
      }
    }
  }
  const kept = fs.readdirSync(dir).sort().map((n) => (fs.statSync(path.join(dir, n)).isDirectory() ? `${n}/` : n));

  const result: PurgeResult = {
    event,
    work_id: opts.workId,
    actor,
    reason,
    previous_publish_mode: prev,
    publish_mode: "Restricted",
    no_change: prev === "Restricted",
    history_entry: entry,
    ledger_line: "",
    jobs,
    elapsed_ms: 0,
    build: { out: opts.buildOut ?? "", summary: null, elapsed_ms: 0 },
    verification: { dist: opts.buildOut ?? "", needles, skipped_needles: skipped, files_scanned: 0, traces: [] },
    push: PUSH_PENDING,
    url_404_check: URL_404_PENDING,
    publish: null,
    deleted,
    kept,
  };

  let failure: string | null = null;
  try {
    // 3) Rebuild without the work.
    if (!opts.buildOut) throw new Error("takedown needs buildOut (the site output directory to rebuild and verify)");
    const build: BuildLike = opts.build ?? (await import("../site/build.ts")).build;
    const tb = performance.now();
    result.build.summary = await build({ worksDir: opts.worksDir, out: opts.buildOut, baseUrl: opts.baseUrl });
    result.build.elapsed_ms = performance.now() - tb;
    // 4) Verify: no trace anywhere in dist (catalog.json, index/genre/media pages, sitemap, search data, …).
    result.verification.files_scanned = listAll(opts.buildOut).length;
    result.verification.traces = distTraces(opts.buildOut, needles);
    if (result.verification.traces.length) {
      const t = result.verification.traces;
      failure = `verification FAILED: ${t.length} trace(s) of ${opts.workId} remain in dist (${t.slice(0, 5).map((x) => `${x.file}:${x.needle}`).join(", ")}${t.length > 5 ? ", …" : ""})`;
    }
  } catch (e) {
    failure = `local rebuild failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 4b) M5: push side — only when the local part succeeded (a leaking build is never pushed).
  if (!failure && opts.publish) {
    try {
      const p = await opts.publish({ workId: opts.workId, needles, event, reason, actor });
      result.push = p.push;
      result.url_404_check = p.url_404_check;
      result.publish = { release_id: p.release_id, ok: p.ok, detail: p.detail };
      if (!p.ok) failure = `push side FAILED: ${p.push}; url 404 check: ${p.url_404_check}`;
    } catch (e) {
      result.push = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
      result.publish = { release_id: null, ok: false };
      failure = `push side FAILED: ${result.push}`;
    }
  }

  // 5) Record (history detail + one ledger line), whatever the outcome.
  const v = result.verification;
  const detail = [
    `${prev} -> Restricted`,
    failure ?? `rebuilt ${opts.buildOut} without the work; verified ${v.files_scanned} files x ${v.needles.length} needles: 0 traces`,
    event === "purge" ? `deleted ${deleted.length ? deleted.join(",") : "(nothing: gen/ releases/ absent)"}; kept ${kept.join(",")}` : "",
    `push ${result.push}`,
    `url 404 check ${result.url_404_check}`,
    jobSummary(jobs),
  ]
    .filter(Boolean)
    .join("; ");
  entry.detail = detail;
  const fresh = readWork(dir);
  const last = fresh.history[fresh.history.length - 1];
  if (last && last.at === entry.at && last.event === entry.event) fresh.history[fresh.history.length - 1] = entry;
  else fresh.history.push(entry);
  writeWork(dir, fresh);
  result.ledger_line = appendLedgerLine(opts.ledgerPath, at, event, opts.workId, actor, reason, detail);
  result.elapsed_ms = performance.now() - t0;
  if (failure) throw new TakedownVerificationError(failure, result);
  return result;
}

export async function takedownWork(opts: TakedownOptions): Promise<TakedownResult> {
  const r = await takedownCore(opts, "takedown");
  const { deleted: _d, kept: _k, ...rest } = r;
  return rest;
}

export async function purgeWork(opts: TakedownOptions): Promise<PurgeResult> {
  return takedownCore(opts, "purge");
}
