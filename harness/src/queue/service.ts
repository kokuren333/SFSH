/**
 * SfshService implementation (orchestrator wiring, CP-038): the one place where front-ends (Discord bot) meet the
 * queue (実働Q), the batch import (実働B) and the owner operations on works (M3). Every method only reads/writes
 * files under queue/ and works/ — the pipeline runs in the worker (§4.2 "bot は受付と通知だけ").
 *
 * Permissions (second layer; the bot checks the allow list and owner-only commands first):
 *  - hold / release / takedown: actor.is_owner only (§4.2).
 *  - cancel / answer: submitter or owner (enforced in queue/ops.ts; refusal carries data.reason "not_permitted").
 */
import fs from "node:fs";
import path from "node:path";
import { holdWork, releaseWork, takedownWork, UnknownWorkError } from "../works/ops.ts";
import { batchStatus, cancelBatch, importBatch, refreshBatchForJob } from "./batch/index.ts";
import { answerJob, cancelJob } from "./ops.ts";
import { requeueHeldJobs } from "./held.ts";
import { submitJob } from "./request.ts";
import { jobStatus, queueSummary } from "./status.ts";
import { defaultQueueEnv, findJob, type QueueEnv } from "./store.ts";
import type { Actor, JobRequest, OpResult, SfshService } from "./types.ts";

/** Hook for every job transition: keeps batch.json and the batch notices current (§4.5). */
export function batchHook(env: QueueEnv, now: () => Date = () => new Date()): (job: JobRequest) => void {
  return (job) => {
    refreshBatchForJob(env, job, now());
  };
}

function ownerOnly(actor: Actor, what: string): OpResult | null {
  return actor.is_owner ? null : { ok: false, text: `${what} はオーナーだけが実行できます`, data: { reason: "not_permitted" } };
}

function actorLabel(a: Actor): string {
  return `${a.origin === "cli" ? "owner(cli)" : `${a.origin}:${a.id}`}${a.name ? `(${a.name})` : ""}`;
}

export function createSfshService(env: QueueEnv = defaultQueueEnv(), now: () => Date = () => new Date()): SfshService {
  const hook = batchHook(env, now);
  const opsBase = () => ({ worksDir: env.worksDir, jobsDir: env.jobsDir, ledgerPath: env.ledgerPath, now });
  return {
    request(input) {
      const r = submitJob(env, input, now());
      if (!r.ok) return { ok: false, text: `受け付けられません: ${r.errors.join("／")}`, data: { errors: r.errors } };
      const j = r.job!;
      return { ok: true, text: `受付: ${j.job_id}「${j.work_query}」範囲 ${j.range_raw || "全体"}${j.range === null ? "（範囲を解釈できないため聞き返します）" : ""}`, data: { job_id: j.job_id } };
    },
    importFile(args) {
      const r = importBatch(env, { ...args }, now());
      return { ok: r.ok, text: r.text, data: r.ok && !r.dryRun ? { batch_id: r.batch.batch_id, counts: r.batch.counts } : r.ok ? { plan: r.plan.counts } : { reason: r.reason } };
    },
    status(target) {
      if (target.batch_id) return batchStatus(env, target.batch_id);
      if (target.job_id) {
        if (/^B\d{8}-\d{3,}$/.test(target.job_id)) return batchStatus(env, target.job_id);
        if (!findJob(env, target.job_id)) return { ok: false, text: `不明なジョブ: ${target.job_id}` };
        return jobStatus(env, target.job_id);
      }
      return queueSummary(env);
    },
    queue() {
      return queueSummary(env);
    },
    cancel(target, actor) {
      if (target.batch_id) return cancelBatch(env, target.batch_id, actor, (id) => cancelJob(env, id, actor, now(), { afterTransition: hook }), now());
      if (!target.job_id) return { ok: false, text: "job_id か batch_id を指定してください" };
      return cancelJob(env, target.job_id, actor, now(), { afterTransition: hook });
    },
    answer(jobId, answer, actor) {
      return answerJob(env, jobId, answer, actor, now(), { afterTransition: hook });
    },
    async hold(workId, reason, actor) {
      const d = ownerOnly(actor, "hold");
      if (d) return d;
      try {
        const r = holdWork({ ...opsBase(), workId, reason: reason ?? undefined, actor: actorLabel(actor) });
        return { ok: true, text: `hold: ${workId} → Restricted（次のビルドから除外）`, data: { publish_mode: r.publish_mode, jobs: r.jobs } };
      } catch (e) {
        return { ok: false, text: e instanceof UnknownWorkError ? `不明な作品: ${workId}` : `hold に失敗: ${(e as Error).message}` };
      }
    },
    async release(workId, reason, actor) {
      const d = ownerOnly(actor, "release");
      if (d) return d;
      try {
        const r = releaseWork({ ...opsBase(), workId, reason: reason ?? undefined, actor: actorLabel(actor) });
        const requeued = requeueHeldJobs(env, workId, now(), hook);
        return { ok: true, text: `release: ${workId} → Public（次のビルドから公開）${requeued.length ? `。保留していたジョブを再開します: ${requeued.join(", ")}` : ""}`, data: { publish_mode: r.publish_mode, jobs: r.jobs, requeued } };
      } catch (e) {
        return { ok: false, text: e instanceof UnknownWorkError ? `不明な作品: ${workId}` : `release に失敗: ${(e as Error).message}` };
      }
    },
    async takedown(workId, reason, actor) {
      const d = ownerOnly(actor, "takedown");
      if (d) return d;
      try {
        const r = await takedownWork({ ...opsBase(), workId, reason: reason ?? undefined, actor: actorLabel(actor), buildOut: env.siteOut });
        return { ok: true, text: `takedown: ${workId} を除外して再ビルドしました（痕跡 ${r.verification.traces.length} 件）。push と公開 URL の確認は M5`, data: { traces: r.verification.traces.length } };
      } catch (e) {
        return { ok: false, text: e instanceof UnknownWorkError ? `不明な作品: ${workId}` : `takedown に失敗: ${(e as Error).message}` };
      }
    },
  };
}

/** True when the queue env looks initialized (used by front-ends for a friendly error). */
export function queueReady(env: QueueEnv): boolean {
  return fs.existsSync(path.join(env.queueDir, "inbox"));
}
