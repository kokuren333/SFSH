/**
 * `sfsh status --batch <batch_id>` and `sfsh cancel --batch <batch_id>` (§4.5 照会・取消).
 * batchStatus reads batch.json and the live job files (it writes nothing). cancelBatch cancels only unfinished rows
 * through the injected job-cancel function (queue ops belong to the worker package), then refreshes the record.
 */
import { isoLocal } from "../../model/callLog.ts";
import { findJob, type QueueEnv } from "../store.ts";
import { TERMINAL_STATES, type Actor, type JobRequest, type OpResult } from "../types.ts";
import { readBatch } from "./record.ts";
import { applyJobToRow, refreshBatch, stateJa } from "./refresh.ts";
import { BATCH_ID_RE, showTitle, type BatchRow } from "./types.ts";

export interface BatchStatusRow {
  line: number;
  title: string;
  range: string;
  status: BatchRow["status"];
  job_id: string | null;
  state: BatchRow["state"];
  title_resolved: string | null;
  work_id: string | null;
  outcome: string;
}

export function batchStatus(env: QueueEnv, batchId: string): OpResult & { data: unknown } {
  if (!BATCH_ID_RE.test(batchId)) return { ok: false, text: `batch_id の形式が不正です: ${batchId}（例: B20261123-001）`, data: null };
  const rec = readBatch(env, batchId);
  if (!rec) return { ok: false, text: `不明な batch_id: ${batchId}`, data: null };
  const rows: BatchStatusRow[] = rec.rows.map((r0) => {
    const r: BatchRow = { ...r0, input: { ...r0.input }, effective: { ...r0.effective } };
    const job = r.job_id ? (findJob(env, r.job_id)?.job ?? null) : null;
    if (r.job_id) applyJobToRow(env, r, job);
    return { line: r.line, title: r.input.title, range: r.effective.range_label ?? r.effective.range_raw, status: r.status, job_id: r.job_id, state: r.state, title_resolved: r.title_resolved, work_id: r.work_id, outcome: r.outcome };
  });
  const lines = [
    `batch ${rec.batch_id}（${rec.file.name}、${rec.file.encoding}）受付 ${rec.created_at}`,
    `${rec.counts.rows} 行: 投入 ${rec.counts.accepted}／エラー ${rec.counts.errors}／重複 ${rec.counts.duplicates}` +
      `　通知: 受付 ${rec.notices.accepted ? "済" : "未"}・同定 ${rec.notices.identified ? "済" : "未"}・終了 ${rec.notices.finished ? "済" : "未"}`,
  ];
  for (const r of rows) {
    const canon = r.title_resolved && r.title_resolved !== r.title ? ` → 『${r.title_resolved}』` : "";
    lines.push(`  ${String(r.line).padStart(4)} ${(r.job_id ?? "-").padEnd(13)} ${(r.state ? stateJa(r.state) : r.status === "error" ? "エラー" : r.status === "duplicate" ? "重複" : "—").padEnd(8)} 「${showTitle(r.title)}」${canon}  ${r.outcome}`);
  }
  return {
    ok: true,
    text: lines.join("\n"),
    data: { batch_id: rec.batch_id, file: rec.file, created_at: rec.created_at, counts: rec.counts, progress: rec.progress, notices: rec.notices, warnings: rec.warnings, rows },
  };
}

function unfinished(job: JobRequest | null): boolean {
  return !!job && !TERMINAL_STATES.includes(job.state);
}

/**
 * Cancel the unfinished rows of a batch. Only the batch's requester or the owner may do it (the injected cancelJob may
 * check again per job). Finished rows, error rows and in-file duplicates are left as they are.
 */
export function cancelBatch(env: QueueEnv, batchId: string, actor: Actor, cancelJob: (jobId: string) => OpResult, now: Date = new Date()): OpResult {
  if (!BATCH_ID_RE.test(batchId)) return { ok: false, text: `batch_id の形式が不正です: ${batchId}` };
  const rec = readBatch(env, batchId);
  if (!rec) return { ok: false, text: `不明な batch_id: ${batchId}` };
  if (!actor.is_owner && actor.id !== rec.requester.id) return { ok: false, text: `取消できるのは投入者かオーナーだけです（${batchId}）` };
  const cancelled: { line: number; job_id: string; text: string }[] = [];
  const failed: { line: number; job_id: string; text: string }[] = [];
  const skipped: { line: number; job_id: string | null; reason: string }[] = [];
  for (const r of rec.rows) {
    if (!r.job_id) {
      skipped.push({ line: r.line, job_id: null, reason: r.status === "duplicate" ? "重複行（ジョブなし）" : "エラー行（ジョブなし）" });
      continue;
    }
    const job = findJob(env, r.job_id)?.job ?? null;
    if (!unfinished(job)) {
      skipped.push({ line: r.line, job_id: r.job_id, reason: job ? `終了済み（${stateJa(job.state)}）` : "ジョブなし" });
      continue;
    }
    const res = cancelJob(r.job_id);
    (res.ok ? cancelled : failed).push({ line: r.line, job_id: r.job_id, text: res.text });
  }
  refreshBatch(env, batchId, now);
  const lines = [`batch ${batchId} の取消（${isoLocal(now)}）: 取消 ${cancelled.length}／取消できず ${failed.length}／対象外 ${skipped.length}`];
  for (const c of cancelled) lines.push(`  ${c.line}行目 ${c.job_id}: ${c.text}`);
  for (const f of failed) lines.push(`  ${f.line}行目 ${f.job_id}: 取消できません: ${f.text}`);
  return { ok: failed.length === 0, text: lines.join("\n"), data: { batch_id: batchId, cancelled, failed, skipped } };
}
