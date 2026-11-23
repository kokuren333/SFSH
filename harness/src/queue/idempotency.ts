/**
 * Idempotency key and merge of duplicate requests (§4.4, §4.5, PLAN §2).
 *
 * key = `${work_id}|${rangeKey(range)}|1.0` (schema_version = NKG "1.0"), computed after identification.
 * Merge targets: queue jobs with the same key in received/identifying (already identified), queued,
 * researching..building, built, published or held — and legacy M1–M3 jobs (logs/jobs/<id>.state.json without a
 * queue file) whose runner state is "done" (key from work_id + request.range). failed / cancelled / merged never count.
 */
import fs from "node:fs";
import path from "node:path";
import type { JobState } from "../job/runner.ts";
import { notifyJob, type OpHooks } from "./ops.ts";
import { rangeKey } from "./range.ts";
import { findJob, listJobs, saveJob, type QueueEnv } from "./store.ts";
import type { JobRequest, JobStateName, MergedRequest, RangeItem } from "./types.ts";

export const SCHEMA_VERSION = "1.0";

export function idempotencyKey(workId: string, range: RangeItem[] | null | undefined): string {
  return `${workId}|${rangeKey(range)}|${SCHEMA_VERSION}`;
}

export const MERGEABLE_STATES: readonly JobStateName[] = [
  "received",
  "identifying",
  "queued",
  "researching",
  "structuring",
  "generating",
  "checking",
  "building",
  "built",
  "published",
  "held",
];

export type MergeTarget =
  | { kind: "queue"; job_id: string; state: JobStateName; job: JobRequest }
  | { kind: "legacy"; job_id: string; state: "done"; work_id: string };

/** States after which a merged requester is told the outcome right away (target already finished). */
export function targetFinished(t: MergeTarget): boolean {
  return t.kind === "legacy" || t.state === "built" || t.state === "published" || t.state === "held";
}

/** Legacy runner state files (no queue file) in state done, with their idempotency keys. */
export function legacyDoneJobs(env: QueueEnv): { job_id: string; work_id: string; key: string; received_at: string }[] {
  if (!fs.existsSync(env.jobsDir)) return [];
  const out: { job_id: string; work_id: string; key: string; received_at: string }[] = [];
  for (const name of fs.readdirSync(env.jobsDir).sort()) {
    if (!name.endsWith(".state.json")) continue;
    const jobId = name.slice(0, -".state.json".length);
    let st: Partial<JobState>;
    try {
      st = JSON.parse(fs.readFileSync(path.join(env.jobsDir, name), "utf8")) as Partial<JobState>;
    } catch {
      continue;
    }
    if (st.state !== "done" || !st.work_id) continue;
    if (findJob(env, jobId)) continue; // a queue job: judged by its queue file
    out.push({ job_id: jobId, work_id: st.work_id, key: idempotencyKey(st.work_id, (st.request?.range ?? null) as RangeItem[] | null), received_at: st.request?.received_at ?? "" });
  }
  return out;
}

/** The job this request should merge into, or null. Queue jobs first (oldest received_at), then legacy done jobs. */
export function findMergeTarget(env: QueueEnv, job: JobRequest): MergeTarget | null {
  const key = job.idempotency_key;
  if (!key) return null;
  const hits = listJobs(env)
    .map((l) => l.job)
    .filter((j) => j.job_id !== job.job_id && j.idempotency_key === key && MERGEABLE_STATES.includes(j.state) && !j.merged_into)
    .sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : a.job_id < b.job_id ? -1 : 1));
  // never merge into a job that was received after this one and is still waiting for identification
  const target = hits.find((j) => !(j.state === "received" || j.state === "identifying") || j.received_at <= job.received_at);
  if (target) return { kind: "queue", job_id: target.job_id, state: target.state, job: target };
  const legacy = legacyDoneJobs(env).find((l) => l.key === key);
  if (legacy) return { kind: "legacy", job_id: legacy.job_id, state: "done", work_id: legacy.work_id };
  return null;
}

export function mergedEntry(job: JobRequest): MergedRequest {
  return { job_id: job.job_id, origin: job.origin, requester: job.requester, reply_to: job.reply_to, received_at: job.received_at, batch: job.batch };
}

/**
 * Fold `job` (identified, idempotency_key set) into `target`: job → merged (merged_into), target.merged_from += job.
 * The merged requester is told at once (target finished → the outcome; otherwise the target's later notices are
 * also sent to its reply_to). Batch rows get no per-job notice (§4.5).
 */
export function applyMerge(env: QueueEnv, job: JobRequest, target: MergeTarget, now: Date = new Date(), hooks: OpHooks = {}): JobRequest {
  job.state = "merged";
  job.merged_into = target.job_id;
  const saved = saveJob(env, job, `merged into ${target.job_id} (${target.kind === "legacy" ? "legacy job, done" : target.state}; key ${job.idempotency_key})`, now);
  hooks.afterTransition?.(saved.job);
  let targetState: string = target.state;
  if (target.kind === "queue") {
    const fresh = findJob(env, target.job_id)?.job ?? target.job;
    if (!fresh.merged_from.some((m) => m.job_id === job.job_id)) fresh.merged_from.push(mergedEntry(job));
    targetState = fresh.state;
    const t = saveJob(env, fresh, `merged_from += ${job.job_id} (${job.origin}${job.batch ? `, batch ${job.batch.batch_id} line ${job.batch.line}` : ""})`, now);
    hooks.afterTransition?.(t.job);
  }
  const title = job.resolved?.title ?? job.work_query;
  const finished = target.kind === "legacy" || ["built", "published", "held"].includes(targetState);
  const text =
    target.kind === "legacy"
      ? `合流: ${job.job_id}「${title}」は完了済みの既存ジョブ ${target.job_id}（作品 ${target.work_id}）と同じ内容のため合流しました。ローカルプレビュー: ${env.siteOut}`
      : targetState === "built" || targetState === "published"
        ? `合流: ${job.job_id}「${title}」は完了済みの既存ジョブ ${target.job_id} と同じ内容のため合流しました。ローカルプレビュー: ${env.siteOut}`
        : targetState === "held"
          ? `合流: ${job.job_id}「${title}」は既存ジョブ ${target.job_id} に合流しました。この作品は差し止め中です（held）`
          : `合流: ${job.job_id}「${title}」は処理中の既存ジョブ ${target.job_id}（${targetState}）に合流しました。以後の通知はこちらにも届きます`;
  notifyJob(env, saved.job, "merged", text, { merged_into: target.job_id, target_state: targetState, target_finished: finished, idempotency_key: job.idempotency_key }, now);
  return saved.job;
}
