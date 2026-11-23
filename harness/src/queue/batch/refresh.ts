/**
 * refreshBatch (§4.5 通知・バッチ記録): re-reads every row's job and updates batch.json; emits the per-stage batch
 * notices, each at most once per batch (deterministic ids via emitNotice + recorded in batch.json `notices`):
 *   <batch_id>.batch_identified — when no row is received / identifying any more: 確定／表記を正式名称へ補正／
 *                                 聞き返し中／エラー, the correction list and ALL clarifying rows with candidates (one message);
 *   <batch_id>.batch_finished   — when every row is terminal: the result tally.
 * The worker calls refreshBatchForJob after each transition of a batch job (hook wired by the orchestrator).
 */
import fs from "node:fs";
import { isoLocal } from "../../model/callLog.ts";
import { normalizeQuery } from "../../research/identify/normalize.ts";
import { emitNotice } from "../notify.ts";
import { findJob, listJobs, type QueueEnv } from "../store.ts";
import { TERMINAL_STATES, type JobRequest, type JobStateName, type Notice } from "../types.ts";
import { acquireBatchLock, batchJsonPath, listBatchIds, readBatch, writeBatch } from "./record.ts";
import { showTitle, type BatchProgress, type BatchRecord, type BatchRow } from "./types.ts";

export type RowClass = "pending" | "confirmed" | "corrected" | "clarifying" | "error" | "duplicate" | "cancelled" | "missing" | "unqueued";

const STATE_JA: Record<JobStateName, string> = {
  received: "受付済み（同定待ち）",
  identifying: "同定中",
  clarifying: "聞き返し中",
  queued: "処理待ち",
  researching: "調査中",
  structuring: "構造化中",
  generating: "生成中",
  checking: "確認中",
  building: "ビルド中",
  built: "完了",
  publish_pending: "ビルド済み・公開待ち",
  published: "公開済み",
  failed: "失敗",
  cancelled: "取消",
  held: "保留",
  merged: "合流",
};

export function stateJa(s: JobStateName | null): string {
  return s ? STATE_JA[s] : "—";
}

function isCorrection(input: string, canonical: string | null): boolean {
  return canonical !== null && normalizeQuery(input) !== normalizeQuery(canonical);
}

/** Update one row from its job (pure apart from reading the merge target). */
export function applyJobToRow(env: QueueEnv, row: BatchRow, job: JobRequest | null): void {
  if (row.status !== "queued") return;
  if (!job) {
    row.state = null;
    row.outcome = row.job_id ? `エラー: ジョブ ${row.job_id} が見つかりません` : "未投入";
    return;
  }
  row.state = job.state;
  row.merged_into = job.merged_into;
  let resolved = job.resolved;
  let target: JobRequest | null = null;
  if (job.merged_into) {
    target = findJob(env, job.merged_into)?.job ?? null;
    if (!resolved && target?.resolved) resolved = target.resolved;
  }
  row.work_id = resolved?.work_id ?? null;
  row.title_resolved = resolved?.title ?? null;
  row.correction = isCorrection(row.input.title, row.title_resolved);
  const name = row.title_resolved ? `「${row.title_resolved}」` : "";
  switch (job.state) {
    case "received":
    case "identifying":
      row.outcome = stateJa(job.state);
      break;
    case "clarifying":
      row.outcome = `聞き返し中: ${job.clarify?.message ?? "回答待ち"}`;
      break;
    case "merged":
      row.outcome = `${job.merged_into} に合流${name}${target ? `（合流先: ${stateJa(target.state)}）` : ""}`;
      break;
    case "failed":
      row.outcome = `失敗${name}${job.error ? `: ${job.error}` : ""}`;
      break;
    case "built":
    case "published":
    case "held":
    case "cancelled":
      row.outcome = `${stateJa(job.state)}${name}`;
      break;
    default:
      row.outcome = `${stateJa(job.state)}${name}`;
  }
}

export function rowClass(row: BatchRow, job: JobRequest | null): RowClass {
  if (row.status === "error") return "error";
  if (row.status === "duplicate") return "duplicate";
  if (!row.job_id) return "unqueued";
  if (!job) return "missing";
  if (job.state === "received" || job.state === "identifying") return "pending";
  if (job.state === "clarifying") return "clarifying";
  if (row.title_resolved) return row.correction ? "corrected" : "confirmed";
  if (job.state === "cancelled") return "cancelled";
  if (job.state === "merged") return "confirmed"; // merged without a resolved ref on either side: counted as decided
  if (job.state === "failed") return "error";
  return "confirmed";
}

export function rowTerminal(row: BatchRow, job: JobRequest | null): boolean {
  if (row.status !== "queued") return true;
  if (!job) return true; // missing job file: nothing will ever change it
  return TERMINAL_STATES.includes(job.state);
}

function progressOf(rows: BatchRow[], jobs: Map<number, JobRequest | null>): BatchProgress {
  const p: BatchProgress = { pending: 0, confirmed: 0, corrected: 0, clarifying: 0, error: 0, duplicate: 0, cancelled: 0, merged: 0, terminal: 0 };
  for (const r of rows) {
    const j = jobs.get(r.line) ?? null;
    const c = rowClass(r, j);
    if (c === "missing" || c === "unqueued") p.error++;
    else p[c]++;
    if (j?.state === "merged") p.merged++;
    if (rowTerminal(r, j)) p.terminal++;
  }
  return p;
}

function candidateLines(job: JobRequest): string[] {
  return (job.clarify?.candidates ?? []).map((c, i) => {
    const meta = [c.medium, c.first_release_year ? `${c.first_release_year}年` : "", c.creators.slice(0, 3).join("・")].filter(Boolean).join("、");
    return `    ${i + 1}. ${c.title}${meta ? `（${meta}）` : ""}${c.work_id ? ` [${c.work_id}]` : ""}`;
  });
}

function identifiedNotice(rec: BatchRecord, jobs: Map<number, JobRequest | null>, at: string): Notice {
  const p = progressOf(rec.rows, jobs);
  const corrections = rec.rows.filter((r) => r.status === "queued" && r.correction && r.title_resolved);
  const clarifying = rec.rows.filter((r) => r.status === "queued" && jobs.get(r.line)?.state === "clarifying");
  const errors = rec.rows.filter((r) => {
    const c = rowClass(r, jobs.get(r.line) ?? null);
    return c === "error" || c === "missing" || c === "unqueued";
  });
  const lines: string[] = [];
  lines.push(`一覧 ${rec.batch_id}（${rec.file.name}）の同定が済みました。`);
  lines.push(`確定 ${p.confirmed}／表記を正式名称へ補正 ${p.corrected}／聞き返し中 ${p.clarifying}／エラー ${p.error}` + (p.duplicate ? `（ファイル内重複 ${p.duplicate} 行は合流済み）` : "") + (p.cancelled ? `／取消 ${p.cancelled}` : ""));
  if (p.merged) lines.push(`既存ジョブ・既存作品への合流: ${p.merged} 行`);
  if (corrections.length) {
    lines.push("", "【表記の補正（入力 → 正式名称）】");
    for (const r of corrections) lines.push(`  ${r.line}行目: 入力『${showTitle(r.input.title)}』→ 正式名称『${r.title_resolved}』`);
  }
  if (clarifying.length) {
    lines.push("", `【聞き返し ${clarifying.length} 件（回答は job_id ごとに answer で候補番号・作品名・範囲を指定）】`);
    for (const r of clarifying) {
      const j = jobs.get(r.line)!;
      lines.push(`  ${r.line}行目「${showTitle(r.input.title)}」${r.effective.range_label && r.effective.range_label !== "全体" ? ` 範囲 ${r.effective.range_label}` : ""}（${r.job_id}）: ${j.clarify?.message ?? "回答待ち"}`);
      lines.push(...candidateLines(j));
    }
  }
  if (errors.length) {
    lines.push("", "【エラー】");
    for (const r of errors) lines.push(`  ${r.line}行目「${showTitle(r.input.title)}」: ${r.outcome.replace(/^エラー: /, "")}`);
  }
  return {
    id: `${rec.batch_id}.batch_identified`,
    at,
    kind: "batch_identified",
    job_id: null,
    batch_id: rec.batch_id,
    origin: rec.origin,
    reply_to: rec.reply_to,
    text: lines.join("\n"),
    data: {
      breakdown: { confirmed: p.confirmed, corrected: p.corrected, clarifying: p.clarifying, error: p.error, duplicate: p.duplicate, cancelled: p.cancelled, merged: p.merged },
      corrections: corrections.map((r) => ({ line: r.line, job_id: r.job_id, input: r.input.title, title: r.title_resolved, work_id: r.work_id })),
      clarifying: clarifying.map((r) => {
        const j = jobs.get(r.line)!;
        return { line: r.line, job_id: r.job_id, input: r.input.title, range: r.effective.range_raw, reason: j.clarify?.reason ?? null, message: j.clarify?.message ?? null, candidates: j.clarify?.candidates ?? [] };
      }),
      errors: errors.map((r) => ({ line: r.line, input: r.input.title, error: r.error ?? r.outcome })),
    },
  };
}

type FinalClass = "done" | "merged" | "failed" | "held" | "cancelled" | "error" | "duplicate";

function finalClass(r: BatchRow, j: JobRequest | null): FinalClass {
  if (r.status === "error") return "error";
  if (r.status === "duplicate") return "duplicate";
  if (!j) return "error";
  if (j.state === "built" || j.state === "published") return "done";
  if (j.state === "merged") return "merged";
  if (j.state === "held") return "held";
  if (j.state === "cancelled") return "cancelled";
  return "failed";
}

function finishedNotice(rec: BatchRecord, jobs: Map<number, JobRequest | null>, at: string): Notice {
  const tally: Record<FinalClass, number> = { done: 0, merged: 0, failed: 0, held: 0, cancelled: 0, error: 0, duplicate: 0 };
  const notDone: BatchRow[] = [];
  for (const r of rec.rows) {
    const c = finalClass(r, jobs.get(r.line) ?? null);
    tally[c]++;
    if (c === "failed" || c === "held" || c === "cancelled" || c === "error") notDone.push(r);
  }
  const lines = [
    `一覧 ${rec.batch_id}（${rec.file.name}）の全 ${rec.rows.length} 行が終わりました。`,
    `完了 ${tally.done}／合流 ${tally.merged}／失敗 ${tally.failed}／保留 ${tally.held}／取消 ${tally.cancelled}／エラー ${tally.error}／ファイル内重複 ${tally.duplicate}`,
  ];
  if (notDone.length) {
    lines.push("", "【完了しなかった行】");
    for (const r of notDone) lines.push(`  ${r.line}行目「${showTitle(r.input.title)}」${r.job_id ? `（${r.job_id}）` : ""}: ${r.outcome}`);
  }
  lines.push("", `各行の結末: sfsh status --batch ${rec.batch_id}`);
  return {
    id: `${rec.batch_id}.batch_finished`,
    at,
    kind: "batch_finished",
    job_id: null,
    batch_id: rec.batch_id,
    origin: rec.origin,
    reply_to: rec.reply_to,
    text: lines.join("\n"),
    data: {
      tally,
      rows: rec.rows.map((r) => ({ line: r.line, input: r.input.title, job_id: r.job_id, state: r.state, status: r.status, title: r.title_resolved, work_id: r.work_id, outcome: r.outcome })),
    },
  };
}

export function acceptedNotice(rec: BatchRecord, at: string): Notice {
  const errs = rec.rows.filter((r) => r.status === "error");
  const dups = rec.rows.filter((r) => r.status === "duplicate");
  const lines = [
    `一覧 ${rec.batch_id}（${rec.file.name}、${rec.file.encoding}）を受け付けました: ${rec.counts.rows} 行 → 投入 ${rec.counts.accepted}／エラー ${rec.counts.errors}／重複 ${rec.counts.duplicates}`,
  ];
  for (const r of errs) lines.push(`  ${r.line}行目「${showTitle(r.input.title)}」: ${r.error}（投入しません）`);
  for (const r of dups) lines.push(`  ${r.line}行目「${showTitle(r.input.title)}」: ${r.duplicate_of_line}行目と重複のため合流`);
  for (const w of rec.warnings) lines.push(`  注意: ${w}`);
  lines.push("同定が済んだら内訳と聞き返しをまとめて1通でお知らせします。");
  return {
    id: `${rec.batch_id}.batch_accepted`,
    at,
    kind: "batch_accepted",
    job_id: null,
    batch_id: rec.batch_id,
    origin: rec.origin,
    reply_to: rec.reply_to,
    text: lines.join("\n"),
    data: {
      counts: rec.counts,
      file: { name: rec.file.name, encoding: rec.file.encoding },
      errors: errs.map((r) => ({ line: r.line, input: r.input.title, error: r.error })),
      duplicates: dups.map((r) => ({ line: r.line, input: r.input.title, duplicate_of_line: r.duplicate_of_line })),
      jobs: rec.rows.filter((r) => r.job_id).map((r) => ({ line: r.line, job_id: r.job_id })),
      warnings: rec.warnings,
    },
  };
}

/** Emit the accepted notice once and record it (also used by import and by crash recovery). */
export function ensureAcceptedNotice(env: QueueEnv, rec: BatchRecord, now: Date): void {
  if (rec.notices.accepted) return;
  const at = isoLocal(now);
  emitNotice(env, acceptedNotice(rec, at));
  rec.notices.accepted = at; // also when the notice already existed (crash between emit and write)
}

export interface RefreshResult {
  ok: boolean;
  batch_id: string;
  /** Notices emitted by this call. */
  emitted: string[];
  progress: BatchProgress | null;
  reason?: string;
}

/**
 * Crash during import (the importer holds the lock for the whole import, so finding import_complete=false while we
 * hold the lock means the importer died): adopt the jobs it already created, mark the rest as errors, finish the record.
 */
function recoverInterruptedImport(env: QueueEnv, rec: BatchRecord, now: Date): void {
  const byLine = new Map<number, string>();
  for (const l of listJobs(env)) if (l.job.batch?.batch_id === rec.batch_id) byLine.set(l.job.batch.line, l.job.job_id);
  for (const r of rec.rows) {
    if (r.status !== "queued" || r.job_id) continue;
    const id = byLine.get(r.line);
    if (id) r.job_id = id;
    else {
      r.status = "error";
      r.error = "取り込みが中断されたため投入されていません";
      r.outcome = `エラー: ${r.error}`;
    }
  }
  rec.counts.accepted = rec.rows.filter((r) => r.status === "queued").length;
  rec.counts.errors = rec.rows.filter((r) => r.status === "error").length;
  rec.warnings.push(`取り込みが中断されていたため ${isoLocal(now)} に復旧しました`);
  rec.import_complete = true;
  ensureAcceptedNotice(env, rec, now);
}

export function refreshBatch(env: QueueEnv, batchId: string, now: Date = new Date()): RefreshResult {
  if (!fs.existsSync(batchJsonPath(env, batchId))) return { ok: false, batch_id: batchId, emitted: [], progress: null, reason: "batch.json がありません" };
  const release = acquireBatchLock(env, batchId);
  if (!release) return { ok: false, batch_id: batchId, emitted: [], progress: null, reason: "batch lock busy" };
  try {
    const rec = readBatch(env, batchId);
    if (!rec) return { ok: false, batch_id: batchId, emitted: [], progress: null, reason: "batch.json がありません" };
    if (!rec.import_complete) recoverInterruptedImport(env, rec, now);
    const jobs = new Map<number, JobRequest | null>();
    for (const r of rec.rows) {
      const job = r.job_id ? (findJob(env, r.job_id)?.job ?? null) : null;
      jobs.set(r.line, job);
      applyJobToRow(env, r, job);
    }
    // duplicate rows follow the row they were merged into
    const byLine = new Map(rec.rows.map((r) => [r.line, r]));
    for (const r of rec.rows) {
      if (r.status !== "duplicate" || r.duplicate_of_line === null) continue;
      const first = byLine.get(r.duplicate_of_line);
      r.work_id = first?.work_id ?? null;
      r.title_resolved = first?.title_resolved ?? null;
      r.correction = isCorrection(r.input.title, r.title_resolved);
      r.outcome = `${r.duplicate_of_line}行目と重複（合流）${first?.job_id ? `→ ${first.job_id}: ${first.outcome}` : ""}`;
    }
    const emitted: string[] = [];
    const at = isoLocal(now);
    const anyPending = rec.rows.some((r) => rowClass(r, jobs.get(r.line) ?? null) === "pending");
    if (!anyPending && !rec.notices.identified) {
      if (emitNotice(env, identifiedNotice(rec, jobs, at))) emitted.push(`${batchId}.batch_identified`);
      rec.notices.identified = at;
    }
    const allTerminal = rec.rows.every((r) => rowTerminal(r, jobs.get(r.line) ?? null));
    if (allTerminal && rec.notices.identified && !rec.notices.finished) {
      if (emitNotice(env, finishedNotice(rec, jobs, at))) emitted.push(`${batchId}.batch_finished`);
      rec.notices.finished = at;
    }
    rec.progress = progressOf(rec.rows, jobs);
    rec.updated_at = at;
    writeBatch(env, rec);
    return { ok: true, batch_id: batchId, emitted, progress: rec.progress };
  } finally {
    release();
  }
}

/** Worker hook: no-op for non-batch jobs; never throws (a batch-record problem must not stop the worker). */
export function refreshBatchForJob(env: QueueEnv, job: Pick<JobRequest, "batch">, now: Date = new Date()): RefreshResult | null {
  if (!job.batch) return null;
  try {
    return refreshBatch(env, job.batch.batch_id, now);
  } catch (e) {
    return { ok: false, batch_id: job.batch.batch_id, emitted: [], progress: null, reason: (e as Error).message };
  }
}

/** Refresh every batch that has not finished yet (worker start-up after a restart). */
export function refreshAllBatches(env: QueueEnv, now: Date = new Date()): RefreshResult[] {
  const out: RefreshResult[] = [];
  for (const id of listBatchIds(env)) {
    try {
      const rec = readBatch(env, id);
      if (rec && rec.import_complete && rec.notices.finished) continue;
      out.push(refreshBatch(env, id, now));
    } catch (e) {
      out.push({ ok: false, batch_id: id, emitted: [], progress: null, reason: (e as Error).message });
    }
  }
  return out;
}
