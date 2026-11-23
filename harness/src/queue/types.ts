/**
 * M4 shared contract (REQUIREMENTS v1.4 §4.1–4.5, WP-4.1〜4.5). Written by the orchestrator before the
 * worker packages; every M4 module (queue worker, batch import, Discord bot, CLI) codes against these types.
 *
 * Layout (§1.4, plus two orchestrator additions recorded in the ledger CP-037):
 *   queue/inbox/      received / identifying / clarifying           (S0 intake; JSON dropped here by Muse is a valid entry)
 *   queue/ready/      queued                                         (identified, waiting for the single worker)
 *   queue/running/    researching / structuring / generating / checking / building
 *   queue/done/       built / published / merged                     (merged = duplicate folded into another job, §4.4)
 *   queue/failed/     failed
 *   queue/held/       held
 *   queue/cancelled/  cancelled                                      (addition: terminal state of §4.4 needs a place)
 *   queue/batches/<batch_id>/  source file copy + batch.json        (§4.5)
 *   queue/outbox/pending|sent/  notifications for reply_to           (addition: worker → bot hand-off, §4.2 "bot is a thin layer")
 *
 * One job = one file `queue/<dir>/<job_id>.json` holding the §4.1 JobRequest plus queue bookkeeping.
 * A state change inside the same directory is "write tmp + rename"; a change of directory is a single
 * fs.renameSync (atomic on one volume). Every transition is appended to logs/jobs/<job_id>.log.
 * The per-stage checkpoint of the pipeline stays in logs/jobs/<job_id>.state.json (job/runner.ts).
 */
import type { ResolvedRef, IdentifyCandidate, ClarifyReason } from "../research/identify/index.ts";

export type { ResolvedRef, IdentifyCandidate };

export const QUEUE_DIRS = ["inbox", "ready", "running", "done", "failed", "held", "cancelled"] as const;
export type QueueDir = (typeof QUEUE_DIRS)[number];

/** §4.4 states (+ "merged" for a duplicate request folded into another job; orchestrator decision CP-037). */
export const JOB_STATES = [
  "received",
  "identifying",
  "clarifying",
  "queued",
  "researching",
  "structuring",
  "generating",
  "checking",
  "building",
  "built",
  "published",
  "failed",
  "cancelled",
  "held",
  "merged",
] as const;
export type JobStateName = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobStateName[] = ["built", "published", "failed", "cancelled", "held", "merged"];

/** Directory that holds a job in each state. */
export const DIR_OF_STATE: Record<JobStateName, QueueDir> = {
  received: "inbox",
  identifying: "inbox",
  clarifying: "inbox",
  queued: "ready",
  researching: "running",
  structuring: "running",
  generating: "running",
  checking: "running",
  building: "running",
  built: "done",
  published: "done",
  merged: "done",
  failed: "failed",
  held: "held",
  cancelled: "cancelled",
};

export type Origin = "discord" | "muse" | "cli";
export type Priority = "normal" | "high";

/** §4.1 range item. "film" is an orchestrator addition for 「劇場版」 (CP-037; schema type additions are allowed by §7.1). */
export type RangeUnit = "whole" | "volume" | "episode" | "arc" | "season" | "film";
export interface RangeItem {
  unit: RangeUnit;
  from: number | null;
  to: number | null;
  label: string;
}

export interface Requester {
  id: string;
  name: string;
}

export type ClarifyKind = ClarifyReason | "range_unparsed";

export interface ClarifyInfo {
  reason: ClarifyKind;
  candidates: IdentifyCandidate[];
  asked_at: string;
  /** Short human text (Japanese) used in the notice. */
  message: string;
}

/** An answer to a clarifying job (`sfsh answer` / `/sfsh answer`). The original work_query is never rewritten (§4.1). */
export interface ClarifyAnswer {
  at: string;
  by: Requester;
  origin: Origin;
  /** 1-based index into clarify.candidates. */
  pick?: number;
  /** New search words for identification (used instead of work_query from now on). */
  work?: string;
  medium?: string;
  range?: string;
}

export interface MergedRequest {
  job_id: string;
  origin: Origin;
  requester: Requester;
  reply_to: string | null;
  received_at: string;
  batch: BatchRef | null;
}

export interface BatchRef {
  batch_id: string;
  line: number;
}

/** §4.1 JobRequest + queue bookkeeping. */
export interface JobRequest {
  job_id: string;
  received_at: string;
  origin: Origin;
  requester: Requester;
  reply_to: string | null;
  /** Input as typed; never rewritten. */
  work_query: string;
  medium_hint: string | null;
  /** Range as typed (empty string when omitted). */
  range_raw: string;
  /** Parsed range; null when range_raw could not be parsed (→ clarifying, reason range_unparsed). */
  range: RangeItem[] | null;
  options: { priority: Priority; note: string };
  batch: BatchRef | null;
  resolved: ResolvedRef | null;
  state: JobStateName;

  // ---- queue bookkeeping (not in the §4.1 sketch; orchestrator decision CP-037) ----
  /** Extra URLs given with the instruction (CLI --url); allowed as source-card origins (§7.4 M1). */
  instruction_urls: { url: string; note: string }[];
  /** `work_id|range key|schema_version`, set after identification (§4.4). */
  idempotency_key: string | null;
  /** Set when this request was folded into another job (state "merged"). */
  merged_into: string | null;
  /** Requests folded into this job; their reply_to also receive this job's notices. */
  merged_from: MergedRequest[];
  clarify: ClarifyInfo | null;
  answers: ClarifyAnswer[];
  cancel_requested: { at: string; by: Requester; origin: Origin } | null;
  /** Set when the job was accepted for a Restricted work (§4.4: processed, never published). */
  restricted_notice_at: string | null;
  error: string | null;
  updated_at: string;
}

/** Input common to CLI / Discord / inbox JSON / batch rows. buildJobRequest() turns it into a JobRequest. */
export interface JobInput {
  origin: Origin;
  requester?: Requester;
  reply_to?: string | null;
  work: string;
  range?: string | null;
  medium?: string | null;
  note?: string | null;
  priority?: Priority | null;
  batch?: BatchRef | null;
  instruction_urls?: { url: string; note: string }[];
}

// ---------------------------------------------------------------- notifications (§4.2, §4.5)

export type NoticeKind =
  | "received" // 受付
  | "clarifying" // 聞き返し
  | "identified" // 正式名称の確定（入力表記と異なる場合の補正を含む §4.6-5）
  | "restricted" // Restricted 作品への指示（公開段へ進めない旨 §4.4）
  | "merged" // 既存ジョブへの合流
  | "completed" // 完了（ローカルプレビューの場所・advisory の件数と要点 §4.2）
  | "failed"
  | "held"
  | "cancelled"
  | "rejected" // 許可外・権限外（Discord）
  | "batch_accepted" // §4.5 受付時に件数
  | "batch_identified" // §4.5 同定完了時の内訳と補正一覧・聞き返し（1通）
  | "batch_finished"; // §4.5 全行終端時の結果集計

export interface Notice {
  /** Deterministic id (e.g. `<job_id>.completed`, `<batch_id>.batch_identified`): written with O_EXCL, so a
   *  restarted worker never sends the same notice twice. */
  id: string;
  at: string;
  kind: NoticeKind;
  job_id: string | null;
  batch_id: string | null;
  origin: Origin;
  /** Discord channel id etc.; null → local only (CLI / Muse read it with `sfsh status` / the outbox). */
  reply_to: string | null;
  /** Japanese text, one notice. Never contains generated page text (§4.2). */
  text: string;
  data: Record<string, unknown>;
  /** Set when moved to outbox/sent/. */
  sent_at?: string;
  sent_via?: string;
}

// ---------------------------------------------------------------- service seam for front-ends

/** Actor of an operation. Local CLI = owner (§4.3). Discord: owner iff the user id is the configured owner. */
export interface Actor {
  id: string;
  name: string;
  origin: Origin;
  is_owner: boolean;
}

/** Uniform result of a front-end operation: `text` is what the bot replies / the CLI prints. */
export interface OpResult {
  ok: boolean;
  text: string;
  data?: unknown;
}

/**
 * Everything a front-end (Discord bot) may ask of SFSH. The bot never runs the pipeline (§4.2); each method
 * only reads/writes files under queue/ and works/. Implemented by queue/service.ts (wired by the orchestrator).
 */
export interface SfshService {
  request(input: JobInput): OpResult;
  importFile(args: { fileName: string; bytes: Uint8Array; range?: string | null; medium?: string | null; priority?: Priority | null; origin: Origin; requester: Requester; reply_to: string | null }): OpResult;
  status(target: { job_id?: string; batch_id?: string }): OpResult;
  queue(): OpResult;
  cancel(target: { job_id?: string; batch_id?: string }, actor: Actor): OpResult;
  answer(jobId: string, answer: Omit<ClarifyAnswer, "at" | "by" | "origin">, actor: Actor): OpResult;
  hold(workId: string, reason: string | null, actor: Actor): Promise<OpResult>;
  release(workId: string, reason: string | null, actor: Actor): Promise<OpResult>;
  takedown(workId: string, reason: string | null, actor: Actor): Promise<OpResult>;
}
