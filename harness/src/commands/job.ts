import fs from "node:fs";
import { completionNotice, newJobState, nextJobId, readState, runJob, statePath, STAGES, type JobState, type StageName } from "../job/runner.ts";
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
  console.error('usage: sfsh job run --work "<title>" [--medium m] [--range r] [--url u]... [--job-id id] | job resume <job_id> [--from <stage>] [--until <stage>] | job status <job_id> [--json]');
  return 2;
}

function deps(until?: StageName) {
  return {
    until,
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
  console.log(`job ${id}: resume`);
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
