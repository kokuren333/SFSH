/**
 * release → held queue jobs continue (orchestrator decision CP-038). In M3 a held job was continued by hand with
 * `sfsh job resume`; with the queue, `release` puts the work's held queue jobs back to `queued`, and the worker resumes
 * them from the first unfinished stage (the runner's per-stage checkpoint is untouched; its own hold check re-runs).
 */
import { listJobs, saveJob, withQueueLock, type QueueEnv } from "./store.ts";
import type { JobRequest } from "./types.ts";

export function requeueHeldJobs(env: QueueEnv, workId: string, now: Date = new Date(), afterTransition?: (job: JobRequest) => void): string[] {
  return withQueueLock(env, () => {
  const out: string[] = [];
  for (const { job } of listJobs(env, ["held"])) {
    if (job.state !== "held" || job.resolved?.work_id !== workId) continue;
    job.state = "queued";
    const saved = saveJob(env, job, `requeued: work ${workId} was released; the worker resumes from the first unfinished stage`, now);
    afterTransition?.(saved.job);
    out.push(job.job_id);
  }
  return out;
  });
}
