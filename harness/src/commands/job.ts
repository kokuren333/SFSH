import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import { completionNotice, newJobState, nextJobId, readState, runJob, statePath, STAGES, writeJobBudget, writeState, type JobState, type StageName } from "../job/runner.ts";
import { readWork } from "../works/store.ts";
import { getModelPort } from "../model/index.ts";
import { paths } from "../paths.ts";
import { createFetcher } from "../research/fetch/index.ts";

/**
 * `sfsh job run --work "<title>" [--medium m] [--range r] [--url <instruction url>]... [--job-id id] [--until <stage>]`
 * `sfsh job resume <job_id>` / `sfsh job status <job_id> [--json]`
 * M1 entry for S0–S2 on one work (the queue proper is M4).
 */
export async function jobCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "run") return jobRun(rest);
  if (sub === "resume") return jobResume(rest);
  if (sub === "status") return jobStatus(rest);
  if (sub === "rework") return jobRework(rest);
  console.error('usage: sfsh job run --work "<title>" [--medium m] [--range r] [--url u]... [--job-id id] | job resume <job_id> [--from <stage>] [--until <stage>] | job status <job_id> [--json] | job rework <work_id> [--until <stage>] [--create-only]');
  return 2;
}

function deps(until?: StageName, reviewRounds?: number) {
  return {
    until,
    reviewRounds,
    luna: getModelPort("luna"),
    haiku: getModelPort("haiku"),
    fetcher: createFetcher(),
    worksDir: paths.works,
    jobsDir: paths.jobLogDir,
  };
}

async function jobRun(args: string[]): Promise<number> {
  let work = "";
  let medium: string | null = null;
  let range = "全体";
  let jobId: string | null = null;
  let until: StageName | undefined;
  const urls: { url: string; note: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--work" && v !== undefined) (work = v), i++;
    else if (a === "--medium" && v !== undefined) (medium = v), i++;
    else if (a === "--range" && v !== undefined) (range = v), i++;
    else if (a === "--job-id" && v !== undefined) (jobId = v), i++;
    else if (a === "--until" && v !== undefined && (STAGES as readonly string[]).includes(v)) (until = v as StageName), i++;
    else if (a === "--url" && v !== undefined) urls.push({ url: v, note: "instruction (--url)" }), i++;
    else {
      console.error(`unknown option: ${a}`);
      return 2;
    }
  }
  if (!work.trim()) {
    console.error("--work is required");
    return 2;
  }
  const now = new Date();
  const id = jobId ?? nextJobId(paths.jobLogDir, now);
  if (fs.existsSync(statePath(paths.jobLogDir, id))) {
    console.error(`job ${id} already exists; use: sfsh job resume ${id}`);
    return 2;
  }
  const st = newJobState({ jobId: id, workQuery: work, mediumHint: medium, rangeRaw: range, instructionUrls: urls }, now);
  console.log(`job ${id}: start (state file ${statePath(paths.jobLogDir, id)})`);
  const out = await runJob(st, deps(until));
  return report(out);
}

async function jobResume(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: sfsh job resume <job_id>");
    return 2;
  }
  const st = readState(paths.jobLogDir, id);
  // A stage left "running" by a killed process is retried (attempt counter kept, 4.4).
  for (const s of STAGES) {
    if (st.stages[s].status === "running") st.stages[s].status = "pending";
    if (st.stages[s].status === "failed" && st.state === "failed") {
      st.stages[s].status = "pending";
      st.stages[s].attempts = 0; // explicit operator resume grants a fresh retry budget
    }
  }
  if (st.state === "failed") st.state = "received";
  // --from <stage>: re-run that stage and every later one (e.g. after a prompt fix). Earlier outputs are kept.
  const fi = args.indexOf("--from");
  if (fi >= 0) {
    const from = args[fi + 1];
    const k = (STAGES as readonly string[]).indexOf(from ?? "");
    if (k < 0) {
      console.error(`--from: unknown stage ${from}`);
      return 2;
    }
    for (const s of STAGES.slice(k)) Object.assign(st.stages[s], { status: "pending", attempts: 0, error: null });
    st.state = "received";
  }
  const ui = args.indexOf("--until");
  const until = ui >= 0 && (STAGES as readonly string[]).includes(args[ui + 1]) ? (args[ui + 1] as StageName) : undefined;
  // AMENDMENT 12: --review-rounds 1|2 sets the S2 fact / interp review rounds of this run (REQUIREMENTS 3.3: at most 2)
  const ri = args.indexOf("--review-rounds");
  const rr = ri >= 0 ? Number(args[ri + 1]) : undefined;
  if (rr !== undefined && !(rr === 1 || rr === 2)) {
    console.error("--review-rounds must be 1 or 2");
    return 2;
  }
  console.log(`job ${id}: resume${rr ? ` (S2 review rounds ${rr})` : ""}`);
  const out = await runJob(st, deps(until, rr));
  return report(out);
}

/**
 * AMENDMENT 12: `sfsh job rework <work_id> [--until <stage>] [--create-only]` — research an existing work again from
 * scratch with the current research stage. The work's research/ and nkg/ are moved (gen/ is copied) to
 * works/<id>/_rework-backup-<time>/ (local rollback, git-ignored), then a new job is created with the identification
 * done (the work id is already canonical) and its own budget (§1.3 limits unchanged). Run / resume it like any job.
 */
async function jobRework(args: string[]): Promise<number> {
  const workId = args[0];
  if (!workId || workId.startsWith("--")) {
    console.error("usage: sfsh job rework <work_id> [--until <stage>] [--create-only]");
    return 2;
  }
  const workDir = path.join(paths.works, workId);
  if (!fs.existsSync(path.join(workDir, "work.json"))) {
    console.error(`no such work: ${workId}`);
    return 2;
  }
  const ui = args.indexOf("--until");
  const until = ui >= 0 && (STAGES as readonly string[]).includes(args[ui + 1] ?? "") ? (args[ui + 1] as StageName) : undefined;
  const now = new Date();
  const stamp = isoLocal(now).slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const backup = path.join(workDir, `_rework-backup-${stamp}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const d of ["research", "nkg"]) if (fs.existsSync(path.join(workDir, d))) fs.renameSync(path.join(workDir, d), path.join(backup, d));
  // S0 is not redone: keep the identification records (identify_<job>.json) in the new research/. The title evidence
  // cards (work.json title_source_ids) stay in the backup's research/sources.json.
  const oldResearch = path.join(backup, "research");
  if (fs.existsSync(oldResearch)) {
    fs.mkdirSync(path.join(workDir, "research"), { recursive: true });
    for (const f of fs.readdirSync(oldResearch)) if (/^identify_.+\.json$/.test(f)) fs.copyFileSync(path.join(oldResearch, f), path.join(workDir, "research", f));
  }
  if (fs.existsSync(path.join(workDir, "gen")))
    fs.cpSync(path.join(workDir, "gen"), path.join(backup, "gen"), { recursive: true, filter: (src) => !path.basename(src).startsWith("_backup-") });
  const w = readWork(workDir);
  const id = nextJobId(paths.jobLogDir, now);
  const st = newJobState({ jobId: id, workQuery: w.title, mediumHint: w.medium ?? null, rangeRaw: "全体" }, now);
  st.work_id = workId;
  st.resolved = { work_id: workId, method: "rework", title: w.title, backup: path.relative(workDir, backup) };
  Object.assign(st.stages.identify, { status: "done", attempts: 0, started_at: isoLocal(now), finished_at: isoLocal(now), duration_ms: 0, metrics: { method: "rework", searches_used: 0, fetches_used: 0 } });
  writeState(paths.jobLogDir, st, now);
  writeJobBudget(workDir, id, st.budget);
  console.log(`job ${id}: rework of ${workId} (previous research/nkg moved to ${path.relative(paths.works, backup)}; gen copied)`);
  if (args.includes("--create-only")) return 0;
  const out = await runJob(st, deps(until));
  return report(out);
}

function jobStatus(args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error("usage: sfsh job status <job_id> [--json]");
    return 2;
  }
  const st = readState(paths.jobLogDir, id);
  if (args.includes("--json")) {
    console.log(JSON.stringify(st, null, 2));
    return 0;
  }
  console.log(`job ${st.job_id}  state=${st.state}  work=${st.work_id ?? "-"}  budget: search ${st.budget.searchesUsed}/${st.budget.limits.searches}, fetch ${st.budget.fetchesUsed}/${st.budget.limits.fetches}`);
  for (const s of STAGES) {
    const r = st.stages[s];
    console.log(`  ${s.padEnd(10)} ${r.status.padEnd(8)} att=${r.attempts} ${r.duration_ms != null ? Math.round(r.duration_ms / 1000) + "s" : ""} ${r.error ?? ""}`);
  }
  return 0;
}

function report(st: JobState): number {
  console.log(`job ${st.job_id}: ${st.state}${st.work_id ? ` (work ${st.work_id})` : ""}${st.error ? ` — ${st.error}` : ""}`);
  const notice = st.state === "done" ? completionNotice(paths.works, st) : null;
  if (notice) console.log(notice);
  return st.state === "failed" ? 3 : 0;
}
