/**
 * Status views (WP-4.1): `sfsh status` (queue summary) and `sfsh status <job_id>` (one job). Read-only.
 * Both return `{ ok, text, data }` — text for the CLI / bot reply, data for `--json`.
 */
import fs from "node:fs";
import { readState, STAGES, statePath, type JobState } from "../job/runner.ts";
import { listNotices } from "./notify.ts";
import { formatRange } from "./range.ts";
import { findJob, listJobs, type QueueEnv } from "./store.ts";
import { JOB_STATES, type JobRequest, type JobStateName } from "./types.ts";
import { readyOrder } from "./worker.ts";
import { readLockOwner, pidAlive } from "./lock.ts";

export interface StatusView {
  ok: boolean;
  text: string;
  data: Record<string, unknown>;
}

function stateFile(env: QueueEnv, jobId: string): JobState | null {
  if (!fs.existsSync(statePath(env.jobsDir, jobId))) return null;
  try {
    return readState(env.jobsDir, jobId);
  } catch {
    return null;
  }
}

/** The stage the runner is in (running), or the next one to run. */
export function currentStage(st: JobState | null): string | null {
  if (!st) return null;
  const running = STAGES.find((s) => st.stages[s].status === "running");
  if (running) return running;
  return STAGES.find((s) => st.stages[s].status !== "done") ?? null;
}

function oneLine(j: JobRequest): string {
  const title = j.resolved ? `${j.resolved.title} [${j.resolved.work_id}]` : `「${j.work_query}」`;
  return `${j.job_id} ${j.state.padEnd(11)} ${j.options.priority === "high" ? "high " : ""}${title} 範囲 ${j.range ? formatRange(j.range) : `${j.range_raw}（未解釈）`}${j.batch ? ` (batch ${j.batch.batch_id}#${j.batch.line})` : ""}`;
}

export function queueSummary(env: QueueEnv): StatusView {
  const jobs = listJobs(env).map((l) => l.job);
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobStateName, number>;
  for (const j of jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;
  const ready = readyOrder(jobs.filter((j) => j.state === "queued"));
  const running = jobs
    .filter((j) => ["researching", "structuring", "generating", "checking", "building"].includes(j.state))
    .map((j) => ({ job: j, stage: j.state === "building" ? "build" : currentStage(stateFile(env, j.job_id)) }));
  const inbox = jobs.filter((j) => j.state === "received" || j.state === "identifying" || j.state === "clarifying");
  const owner = readLockOwner(env);
  const worker = owner ? { pid: owner.pid, alive: pidAlive(owner.pid) } : null;

  const lines: string[] = [];
  lines.push(`queue: ${JOB_STATES.filter((s) => counts[s] > 0).map((s) => `${s} ${counts[s]}`).join(" / ") || "empty"}`);
  lines.push(`worker: ${worker ? `pid ${worker.pid}${worker.alive ? "" : " (not running: stale lock)"}` : "not running"}`);
  if (running.length) {
    lines.push("running:");
    for (const r of running) lines.push(`  ${oneLine(r.job)} — stage ${r.stage ?? "-"}${r.job.cancel_requested ? " (cancel requested)" : ""}`);
  }
  if (ready.length) {
    lines.push("ready (next first):");
    ready.forEach((j, i) => lines.push(`  ${i + 1}. ${oneLine(j)}`));
  }
  if (inbox.length) {
    lines.push("inbox:");
    for (const j of inbox) lines.push(`  ${oneLine(j)}`);
  }
  return {
    ok: true,
    text: lines.join("\n"),
    data: {
      counts,
      worker,
      running: running.map((r) => ({ job_id: r.job.job_id, state: r.job.state, stage: r.stage, cancel_requested: !!r.job.cancel_requested })),
      ready: ready.map((j) => ({ job_id: j.job_id, priority: j.options.priority, received_at: j.received_at, work_id: j.resolved?.work_id ?? null, batch: j.batch })),
      inbox: inbox.map((j) => ({ job_id: j.job_id, state: j.state, work_query: j.work_query })),
    },
  };
}

export function jobStatus(env: QueueEnv, jobId: string): StatusView {
  const loc = findJob(env, jobId);
  const st = stateFile(env, jobId);
  const stages = st
    ? STAGES.map((s) => ({ stage: s, status: st.stages[s].status, attempts: st.stages[s].attempts, duration_ms: st.stages[s].duration_ms, error: st.stages[s].error }))
    : [];
  const notices = listNotices(env, { job_id: jobId }).map((n) => ({ id: n.id, at: n.at, kind: n.kind, text: n.text, sent_at: n.sent_at ?? null, sent_via: n.sent_via ?? null }));
  if (!loc) {
    if (!st) return { ok: false, text: `不明なジョブ: ${jobId}`, data: { job_id: jobId, reason: "unknown_job" } };
    // legacy M1–M3 job (runner state only)
    const lines = [`job ${jobId} (legacy runner job, no queue file)  state=${st.state}  work=${st.work_id ?? "-"}`, ...stages.map((s) => `  ${s.stage.padEnd(10)} ${s.status.padEnd(8)} att=${s.attempts}${s.error ? ` ${s.error}` : ""}`)];
    return { ok: true, text: lines.join("\n"), data: { job_id: jobId, legacy: true, state: st.state, work_id: st.work_id, request: st.request, stages, notices } };
  }
  const j = loc.job;
  const candidates = (j.clarify?.candidates ?? []).map((c, i) => ({ n: i + 1, ...c }));
  const lines: string[] = [];
  lines.push(`job ${j.job_id}  state=${j.state} (${loc.dir}/)  origin=${j.origin}  requester=${j.requester.name || j.requester.id}  priority=${j.options.priority}`);
  lines.push(`  input: 「${j.work_query}」 range ${j.range_raw || "全体"}${j.range ? ` → ${formatRange(j.range)}` : " (unparsed)"}${j.medium_hint ? ` medium ${j.medium_hint}` : ""}${j.options.note ? ` note: ${j.options.note}` : ""}`);
  if (j.resolved) lines.push(`  work: ${j.resolved.title} [${j.resolved.work_id}] (${j.resolved.method}, ${j.resolved.title_status})  key ${j.idempotency_key ?? "-"}`);
  if (j.batch) lines.push(`  batch: ${j.batch.batch_id} line ${j.batch.line}`);
  if (j.merged_into) lines.push(`  merged into: ${j.merged_into}`);
  if (j.merged_from.length) lines.push(`  merged from: ${j.merged_from.map((m) => `${m.job_id} (${m.origin})`).join(", ")}`);
  if (j.restricted_notice_at) lines.push(`  Restricted work: processed, never published (notified ${j.restricted_notice_at})`);
  if (j.cancel_requested) lines.push(`  cancel requested at ${j.cancel_requested.at} by ${j.cancel_requested.by.name || j.cancel_requested.by.id}`);
  if (j.error) lines.push(`  error: ${j.error}`);
  if (j.clarify) {
    lines.push(`  clarifying (${j.clarify.reason}):`);
    for (const c of candidates) lines.push(`    ${c.n}. ${c.title}（${c.medium}${c.first_release_year != null ? `・${c.first_release_year}` : ""}）${c.work_id ? ` [${c.work_id}]` : ""}`);
    if (j.state === "clarifying") lines.push(`    answer: sfsh answer ${j.job_id} --pick <n> | --work <t> | --medium <m> | --range <r>`);
  }
  if (j.answers.length) lines.push(`  answers: ${j.answers.map((a) => [a.pick != null ? `pick ${a.pick}` : null, a.work ? `work "${a.work}"` : null, a.medium ? `medium ${a.medium}` : null, a.range ? `range "${a.range}"` : null].filter(Boolean).join(" ")).join(" / ")}`);
  if (stages.length) {
    lines.push("  stages:");
    for (const s of stages) lines.push(`    ${s.stage.padEnd(10)} ${s.status.padEnd(8)} att=${s.attempts}${s.duration_ms != null ? ` ${Math.round(s.duration_ms / 1000)}s` : ""}${s.error ? ` ${s.error}` : ""}`);
  }
  if (notices.length) {
    lines.push("  notices:");
    for (const n of notices) lines.push(`    ${n.at} [${n.kind}] ${n.text.split("\n")[0]}${n.sent_at ? "" : " (pending)"}`);
  }
  return {
    ok: true,
    text: lines.join("\n"),
    data: { job_id: j.job_id, dir: loc.dir, state: j.state, request: j, current_stage: currentStage(st), stages, notices, candidates, merged_into: j.merged_into, merged_from: j.merged_from },
  };
}
