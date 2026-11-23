/**
 * One normalizer for every entry (§4.1: "両系統とも同じ JobRequest に正規化"): CLI `sfsh enqueue`, Discord
 * `/sfsh request`, JSON dropped into queue/inbox/ by Muse (§4.3), and batch rows (§4.5) all go through
 * buildJobRequest(). Front-ends differ only in origin / requester / reply_to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import { normalizeMediumHint } from "../research/identify/decide.ts";
import { emitNotice } from "./notify.ts";
import { parseRange } from "./range.ts";
import { allocateJobId, appendJobLog, JOB_ID_RE, saveJob, type QueueEnv } from "./store.ts";
import type { JobInput, JobRequest, Origin, Priority, Requester } from "./types.ts";
import { renameSyncRetry } from "../util/fsRetry.ts";

export const WORK_QUERY_MAX = 200;
export const NOTE_MAX = 500;
const ORIGINS: Origin[] = ["discord", "muse", "cli"];

/** Local CLI / Muse runner = owner (§4.3). */
export function localRequester(): Requester {
  let name = "local";
  try {
    name = os.userInfo().username || "local";
  } catch {
    /* ignore */
  }
  return { id: "local", name };
}

/** Input problems that make the request unusable (not range problems: those become clarifying). */
export function validateJobInput(input: JobInput): string[] {
  const errs: string[] = [];
  const work = (input.work ?? "").normalize("NFKC").trim();
  if (!work) errs.push("作品名が空です");
  if (work.length > WORK_QUERY_MAX) errs.push(`作品名が長すぎます（${WORK_QUERY_MAX}字まで）`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(input.work ?? "")) errs.push("作品名に改行・制御文字があります");
  if (!ORIGINS.includes(input.origin)) errs.push(`origin が不正です: ${String(input.origin)}`);
  if (input.priority != null && input.priority !== "normal" && input.priority !== "high") errs.push(`priority は normal か high です: ${String(input.priority)}`);
  if ((input.note ?? "").length > NOTE_MAX) errs.push(`note が長すぎます（${NOTE_MAX}字まで）`);
  return errs;
}

/** Build the §4.1 JobRequest (state "received", or "clarifying"-to-be when the range is unparsable: range = null). */
export function buildJobRequest(input: JobInput, ids: { job_id: string; received_at: string }): JobRequest {
  const rangeRaw = (input.range ?? "").trim();
  const parsed = parseRange(rangeRaw);
  return {
    job_id: ids.job_id,
    received_at: ids.received_at,
    origin: input.origin,
    requester: input.requester ?? (input.origin === "discord" ? { id: "", name: "" } : localRequester()),
    reply_to: input.reply_to ?? null,
    work_query: input.work, // as typed, never rewritten
    medium_hint: normalizeMediumHint(input.medium ?? null),
    range_raw: rangeRaw,
    range: parsed.ok ? parsed.items : null,
    options: { priority: (input.priority ?? "normal") as Priority, note: (input.note ?? "").trim() },
    batch: input.batch ?? null,
    resolved: null,
    state: "received",
    instruction_urls: input.instruction_urls ?? [],
    idempotency_key: null,
    merged_into: null,
    merged_from: [],
    clarify: null,
    answers: [],
    cancel_requested: null,
    restricted_notice_at: null,
    error: null,
    updated_at: ids.received_at,
  };
}

/** The part of a JobRequest that must be identical whichever front-end produced it (gate 7.2 M4). */
export function comparableRequest(j: JobRequest): Omit<JobRequest, "job_id" | "received_at" | "updated_at" | "origin" | "requester" | "reply_to"> {
  const { job_id: _a, received_at: _b, updated_at: _c, origin: _d, requester: _e, reply_to: _f, ...rest } = j;
  return rest;
}

export interface SubmitResult {
  ok: boolean;
  job?: JobRequest;
  errors: string[];
}

/**
 * Validate → allocate id → write queue/inbox/<job_id>.json (state received) → "received" notice (not for batch rows:
 * batches notify once per stage, §4.5). The worker does everything else.
 */
export function submitJob(env: QueueEnv, input: JobInput, now: Date = new Date()): SubmitResult {
  const errors = validateJobInput(input);
  if (errors.length) return { ok: false, errors };
  const job = buildJobRequest(input, { job_id: allocateJobId(env, now), received_at: isoLocal(now) });
  saveJob(env, job, `received from ${job.origin}${job.batch ? ` (batch ${job.batch.batch_id} line ${job.batch.line})` : ""}`, now);
  if (!job.batch) {
    emitNotice(env, {
      id: `${job.job_id}.received`,
      at: isoLocal(now),
      kind: "received",
      job_id: job.job_id,
      batch_id: null,
      origin: job.origin,
      reply_to: job.reply_to,
      text: `受付: ${job.job_id}「${job.work_query}」範囲 ${job.range_raw || "全体"}${job.range === null ? "（範囲を解釈できないため聞き返します）" : ""}`,
      data: { work_query: job.work_query, range_raw: job.range_raw, priority: job.options.priority },
    });
  }
  return { ok: true, job, errors: [] };
}

/**
 * Adopt a foreign file dropped into queue/inbox/ (Muse, §4.3): any `*.json` that is not `<job_id>.json`, holding
 * either a JobInput-like object `{ work | work_query, range | range_raw, medium | medium_hint, note, priority, origin, reply_to, requester }`.
 * The original file is moved to queue/inbox/_adopted/ (kept, not deleted). Invalid drops are moved to queue/inbox/_rejected/.
 */
export function adoptInboxDrops(env: QueueEnv, now: Date = new Date()): { adopted: JobRequest[]; rejected: { file: string; errors: string[] }[] } {
  const inbox = path.join(env.queueDir, "inbox");
  const adopted: JobRequest[] = [];
  const rejected: { file: string; errors: string[] }[] = [];
  if (!fs.existsSync(inbox)) return { adopted, rejected };
  for (const name of fs.readdirSync(inbox).sort()) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const id = name.slice(0, -5);
    if (JOB_ID_RE.test(id)) continue;
    const file = path.join(inbox, name);
    if (!fs.statSync(file).isFile()) continue;
    let raw: Record<string, unknown>;
    let errors: string[] = [];
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("JSON object expected");
    } catch (e) {
      raw = {};
      errors = [`JSON を読めません: ${(e as Error).message}`];
    }
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
    const origin = (str(raw.origin) ?? "muse") as Origin;
    const input: JobInput = {
      origin,
      requester: raw.requester && typeof raw.requester === "object" ? (raw.requester as Requester) : undefined,
      reply_to: str(raw.reply_to),
      work: str(raw.work ?? raw.work_query) ?? "",
      range: str(raw.range_raw ?? (typeof raw.range === "string" ? raw.range : null)),
      medium: str(raw.medium ?? raw.medium_hint),
      note: str(raw.note ?? (raw.options as { note?: unknown } | undefined)?.note),
      priority: (str(raw.priority ?? (raw.options as { priority?: unknown } | undefined)?.priority) as Priority | null) ?? null,
    };
    if (!errors.length) errors = validateJobInput(input);
    const sub = errors.length ? null : submitJob(env, input, now);
    const destDir = path.join(inbox, sub?.ok ? "_adopted" : "_rejected");
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, sub?.ok ? `${sub.job!.job_id}__${name}` : `${isoLocal(now).replace(/[:+]/g, "")}__${name}`);
    renameSyncRetry(file, dest);
    if (sub?.ok) {
      appendJobLog(env, sub.job!.job_id, `queue: adopted inbox drop ${name} (copy kept at ${path.relative(env.queueDir, dest)})`, now);
      adopted.push(sub.job!);
    } else rejected.push({ file: name, errors: sub ? sub.errors : errors });
  }
  return { adopted, rejected };
}
