/**
 * Front-end operations on queue jobs (WP-4.1 / WP-4.3): cancel and answer, plus the per-job notice helper shared
 * with the worker. Pure file operations under queue/ (no pipeline, no model): safe to call from the CLI and the
 * Discord bot while the worker runs. Every read-modify-write re-reads the job file right before saving.
 */
import { isoLocal } from "../model/callLog.ts";
import { normalizeMediumHint } from "../research/identify/decide.ts";
import { WORK_QUERY_MAX } from "./request.ts";
import { emitNotice } from "./notify.ts";
import { formatRange, parseRange } from "./range.ts";
import { findJob, saveJob, withQueueLock, type QueueEnv } from "./store.ts";
import { TERMINAL_STATES, type Actor, type ClarifyAnswer, type ClarifyInfo, type JobRequest, type NoticeKind, type OpResult } from "./types.ts";

export interface OpHooks {
  /** Called after every saveJob of a job (batch record update, wired by the orchestrator). */
  afterTransition?: (job: JobRequest) => void;
}

// ---------------------------------------------------------------- notices

/**
 * Emit one notice of `kind` for a job to its own reply_to (not for batch rows: batches notify per stage, §4.5) and to
 * every non-batch merged_from requester. Ids: `<job_id>.<kind><suffix>` and `<job_id>.<kind><suffix>.<merged_job_id>`.
 * Returns the ids actually written (an id already pending/sent is skipped → at most once across restarts).
 */
export function notifyJob(
  env: QueueEnv,
  job: JobRequest,
  kind: NoticeKind,
  text: string,
  data: Record<string, unknown> = {},
  now: Date = new Date(),
  opts: { suffix?: string; includeMerged?: boolean } = {},
): string[] {
  const suffix = opts.suffix ?? "";
  const written: string[] = [];
  const at = isoLocal(now);
  if (!job.batch) {
    const id = `${job.job_id}.${kind}${suffix}`;
    if (emitNotice(env, { id, at, kind, job_id: job.job_id, batch_id: null, origin: job.origin, reply_to: job.reply_to, text, data: { ...data } })) written.push(id);
  }
  if (opts.includeMerged !== false) {
    for (const m of job.merged_from) {
      if (m.batch) continue;
      const id = `${job.job_id}.${kind}${suffix}.${m.job_id}`;
      const t = `（${m.job_id} は ${job.job_id} に合流済み）${text}`;
      if (emitNotice(env, { id, at, kind, job_id: m.job_id, batch_id: null, origin: m.origin, reply_to: m.reply_to, text: t, data: { ...data, merged_into: job.job_id } })) written.push(id);
    }
  }
  return written;
}

function candidateLine(c: ClarifyInfo["candidates"][number], i: number): string {
  const meta = [c.medium, c.first_release_year != null ? `${c.first_release_year}年` : null, c.creators.length ? c.creators.slice(0, 2).join("・") : null].filter(Boolean).join("・");
  return `${i + 1}. ${c.title}（${meta}）${c.work_id ? " [既存作品]" : ""}`;
}

/** Human text of a clarification (Japanese; candidates numbered 1..n). */
export function clarifyText(job: JobRequest, info: Omit<ClarifyInfo, "message">, rangeReason: string | null = null): string {
  const how =
    job.origin === "discord"
      ? `/sfsh answer job_id:${job.job_id} pick:<番号> または work:<作品名> medium:<媒体> range:<範囲>`
      : `sfsh answer ${job.job_id} --pick <番号> | --work <作品名> | --medium <媒体> | --range <範囲>`;
  switch (info.reason) {
    case "range_unparsed":
      return `聞き返し: ${job.job_id}「${job.work_query}」の範囲「${job.range_raw}」を解釈できません${rangeReason ? `（${rangeReason}）` : ""}。範囲（例: 全体／3巻／1-3巻／5話／第2シーズン／「◯◯」編／劇場版／2作目）を答えてください。回答: ${
        job.origin === "discord" ? `/sfsh answer job_id:${job.job_id} range:<範囲>` : `sfsh answer ${job.job_id} --range <範囲>`
      }`;
    case "kind_unknown":
      return `聞き返し: ${job.job_id} 種別（fiction/nonfiction/mixed）の根拠を確認できません。書誌出典を添えた作品名で再同定してください。${how}`;
    case "no_candidates":
      return `聞き返し: ${job.job_id}「${job.work_query}」に当たる作品を確認できませんでした。正式な題名や媒体を添えて答えてください。回答: ${how}`;
    case "no_reading":
    case "multiple_candidates":
    case "multiple_index_matches": {
      const lead = info.reason === "no_reading" ? "作品の読みを確認できませんでした" : "候補が複数あります";
      return [`聞き返し: ${job.job_id}「${job.work_query}」— ${lead}。番号で選ぶか、題名・媒体で答えてください。`, ...info.candidates.map(candidateLine), `回答: ${how}`].join("\n");
    }
  }
}

// ---------------------------------------------------------------- permission

function permitted(job: JobRequest, actor: Actor): boolean {
  if (actor.is_owner) return true;
  return !!actor.id && actor.id === job.requester.id;
}

function denied(job: JobRequest, actor: Actor, what: string): OpResult {
  return { ok: false, text: `権限がありません: ${job.job_id} の${what}は投入者かオーナーだけが行えます（${actor.name || actor.id}）`, data: { job_id: job.job_id, reason: "forbidden" } };
}

// ---------------------------------------------------------------- cancel

/**
 * Cancel an unfinished job (§4.2: requester or owner). Not running → cancelled now (with notice). Running
 * (researching..building) → cancel_requested; the worker stops at the next stage boundary. Terminal → refused.
 */
export function cancelJob(env: QueueEnv, jobId: string, actor: Actor, now: Date = new Date(), hooks: OpHooks = {}): OpResult {
  // AMENDMENT 13: read → decide → save under the queue state lock (the worker may move the job meanwhile)
  return withQueueLock(env, () => cancelJobLocked(env, jobId, actor, now, hooks));
}

function cancelJobLocked(env: QueueEnv, jobId: string, actor: Actor, now: Date, hooks: OpHooks): OpResult {
  const loc = findJob(env, jobId);
  if (!loc) return { ok: false, text: `不明なジョブ: ${jobId}`, data: { job_id: jobId, reason: "unknown_job" } };
  const job = loc.job;
  if (!permitted(job, actor)) return denied(job, actor, "取消");
  if (TERMINAL_STATES.includes(job.state)) return { ok: false, text: `${jobId} は終了済みです（${job.state}）。取消できません`, data: { job_id: jobId, state: job.state, reason: "terminal" } };
  if (job.state === "publish_pending" && job.publish_wait?.started_at)
    return { ok: false, text: `${jobId} は公開の実行中です（${job.publish_wait.started_at} 開始）。取消できません`, data: { job_id: jobId, state: job.state, reason: "publishing" } };
  const by = { id: actor.id, name: actor.name };
  if (loc.dir === "running") {
    if (job.cancel_requested) return { ok: true, text: `${jobId} は取消要求済みです（段の区切りで止まります）`, data: { job_id: jobId, state: job.state, cancel_requested: true } };
    job.cancel_requested = { at: isoLocal(now), by, origin: actor.origin };
    const saved = saveJob(env, job, `cancel requested by ${actor.name || actor.id} (${actor.origin}); worker stops at the next stage boundary`, now);
    hooks.afterTransition?.(saved.job);
    return { ok: true, text: `${jobId} の取消を受け付けました。実行中の段が終わったところで止めます`, data: { job_id: jobId, state: job.state, cancel_requested: true } };
  }
  const prev = job.state;
  job.cancel_requested = { at: isoLocal(now), by, origin: actor.origin };
  job.state = "cancelled";
  const saved = saveJob(env, job, `cancelled by ${actor.name || actor.id} (${actor.origin}); was ${prev}`, now);
  hooks.afterTransition?.(saved.job);
  notifyJob(env, saved.job, "cancelled", `取消: ${jobId}「${job.work_query}」を取り消しました（${prev} で停止）`, { previous_state: prev, by }, now);
  return { ok: true, text: `${jobId} を取り消しました（${prev} → cancelled）`, data: { job_id: jobId, state: "cancelled", previous_state: prev } };
}

// ---------------------------------------------------------------- answer

export type AnswerInput = Omit<ClarifyAnswer, "at" | "by" | "origin">;

/** The answer whose pick is still to be resolved by the worker (state received + clarify kept + last answer picks). */
export function pendingPick(job: JobRequest): { pick: number; candidate: ClarifyInfo["candidates"][number] } | null {
  if (job.state !== "received" && job.state !== "identifying") return null;
  if (!job.clarify) return null;
  const last = job.answers[job.answers.length - 1];
  if (!last || last.pick == null) return null;
  const c = job.clarify.candidates[last.pick - 1];
  return c ? { pick: last.pick, candidate: c } : null;
}

/** Search words for identification: the latest answered `work`, else the original work_query (never rewritten). */
export function effectiveQuery(job: JobRequest): string {
  for (let i = job.answers.length - 1; i >= 0; i--) if (job.answers[i].work) return job.answers[i].work!;
  return job.work_query;
}

export function effectiveMedium(job: JobRequest): string | null {
  for (let i = job.answers.length - 1; i >= 0; i--) if (job.answers[i].medium) return normalizeMediumHint(job.answers[i].medium!);
  return job.medium_hint;
}

/**
 * Answer a clarifying job (§4.1 "候補を提示して選ばせる", WP-4.3). Requester or owner. The answer is recorded in
 * answers[]; work_query is never rewritten.
 *  - range: re-parsed; still unparsable → stays clarifying (ok:false).
 *  - pick N: candidate N of clarify.candidates → back to received; the worker resolves exactly that candidate
 *    (existing work: index path; research candidate: from the staged sources, no new search).
 *  - work / medium: back to received; identification re-runs with the answered words / medium.
 */
export function answerJob(env: QueueEnv, jobId: string, answer: AnswerInput, actor: Actor, now: Date = new Date(), hooks: OpHooks = {}): OpResult {
  return withQueueLock(env, () => answerJobLocked(env, jobId, answer, actor, now, hooks));
}

function answerJobLocked(env: QueueEnv, jobId: string, answer: AnswerInput, actor: Actor, now: Date, hooks: OpHooks): OpResult {
  const loc = findJob(env, jobId);
  if (!loc) return { ok: false, text: `不明なジョブ: ${jobId}`, data: { job_id: jobId, reason: "unknown_job" } };
  const job = loc.job;
  if (!permitted(job, actor)) return denied(job, actor, "回答");
  if (job.state !== "clarifying" || !job.clarify) return { ok: false, text: `${jobId} は聞き返し中ではありません（${job.state}）`, data: { job_id: jobId, state: job.state, reason: "not_clarifying" } };
  const work = answer.work?.normalize("NFKC").trim() || undefined;
  const medium = answer.medium?.trim() || undefined;
  const range = answer.range?.trim() || undefined;
  const pick = answer.pick ?? undefined;
  if (pick === undefined && !work && !medium && range === undefined) return { ok: false, text: "回答が空です（pick / work / medium / range のどれかを指定してください）", data: { job_id: jobId, reason: "empty" } };
  if (work && work.length > WORK_QUERY_MAX) return { ok: false, text: `作品名が長すぎます（${WORK_QUERY_MAX}字まで）`, data: { job_id: jobId, reason: "invalid" } };
  if (work && /[\u0000-\u001f]/.test(work)) return { ok: false, text: "作品名に制御文字があります", data: { job_id: jobId, reason: "invalid" } };
  if (pick !== undefined) {
    const n = job.clarify.candidates.length;
    if (job.clarify.reason === "range_unparsed" || n === 0) return { ok: false, text: `${jobId} には選べる候補がありません（${job.clarify.reason}）`, data: { job_id: jobId, reason: "no_candidates" } };
    if (!Number.isInteger(pick) || pick < 1 || pick > n) return { ok: false, text: `pick は 1〜${n} の番号です`, data: { job_id: jobId, reason: "invalid_pick" } };
  }

  const rec: ClarifyAnswer = { at: isoLocal(now), by: { id: actor.id, name: actor.name }, origin: actor.origin };
  if (pick !== undefined) rec.pick = pick;
  if (work) rec.work = work;
  if (medium) rec.medium = medium;
  if (range !== undefined) rec.range = range;
  job.answers.push(rec);
  const who = `${actor.name || actor.id} (${actor.origin})`;

  if (range !== undefined) {
    const parsed = parseRange(range);
    if (!parsed.ok) {
      job.clarify = { reason: "range_unparsed", candidates: [], asked_at: isoLocal(now), message: "" };
      const shown = { ...job, range_raw: range };
      job.clarify.message = clarifyText(shown, job.clarify, parsed.reason);
      const saved = saveJob(env, job, `answer by ${who}: range "${range}" still unparsable (${parsed.reason}); stays clarifying`, now);
      hooks.afterTransition?.(saved.job);
      return { ok: false, text: `範囲「${range}」を解釈できません（${parsed.reason}）。聞き返しのままです`, data: { job_id: jobId, state: "clarifying", reason: "range_unparsed" } };
    }
    job.range = parsed.items;
  }
  if (job.range === null) {
    const saved = saveJob(env, job, `answer by ${who} recorded; the range is still unparsed — stays clarifying`, now);
    hooks.afterTransition?.(saved.job);
    return { ok: false, text: `回答を記録しました。範囲「${job.range_raw}」がまだ解釈できないため、範囲も答えてください`, data: { job_id: jobId, state: "clarifying", reason: "range_unparsed" } };
  }

  let detail: string;
  if (pick !== undefined) {
    const c = job.clarify.candidates[pick - 1];
    detail = `pick ${pick} 「${c.title}」（${c.medium}${c.first_release_year != null ? `・${c.first_release_year}` : ""}）`;
    job.state = "received"; // clarify is kept: the worker resolves the picked candidate from it
  } else if (work || medium) {
    detail = [work ? `work "${work}"` : null, medium ? `medium ${medium}` : null].filter(Boolean).join(", ");
    job.clarify = null;
    job.state = "received";
  } else if (job.clarify.reason === "range_unparsed") {
    detail = `range ${formatRange(job.range)}`;
    job.clarify = null;
    job.state = "received";
  } else {
    // range answered while the work itself is still ambiguous
    const saved = saveJob(env, job, `answer by ${who}: range ${formatRange(job.range)} recorded; work still ambiguous — stays clarifying`, now);
    hooks.afterTransition?.(saved.job);
    return { ok: true, text: `範囲 ${formatRange(job.range)} を記録しました。作品の候補はまだ選ばれていません（pick か work で答えてください）`, data: { job_id: jobId, state: "clarifying" } };
  }
  const saved = saveJob(env, job, `answer by ${who}: ${detail}; back to received (identification continues)`, now);
  hooks.afterTransition?.(saved.job);
  return { ok: true, text: `回答を受け付けました: ${jobId} ${detail}。ワーカーが同定を続けます`, data: { job_id: jobId, state: "received", answer: rec } };
}
