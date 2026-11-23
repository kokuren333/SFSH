/**
 * WP-4.5 batch import (REQUIREMENTS §4.5): types of queue/batches/<batch_id>/batch.json.
 * One file = one batch, one title row = one JobRequest (submitJob with batch ref {batch_id, line}).
 */
import type { JobStateName, Origin, Priority, Requester } from "../types.ts";

/** §4.5 limit per file [暫定・U-18]. Data rows incl. invalid ones; blank / comment lines and the CSV header excluded. */
export const BATCH_LIMIT = 200;
export const BATCH_ID_RE = /^B\d{8}-\d{3}$/;

/** Title as shown in one-line texts (notices, status): newlines visible as ↵, empty as (空). */
export function showTitle(t: string): string {
  return t ? t.replace(/\r\n|\r|\n/g, "↵") : "(空)";
}

export type BatchEncoding = "utf-8" | "utf-8-bom" | "cp932";
export type BatchExt = ".txt" | ".csv";

/** A row as written in the file (trimmed; empty string = column empty / absent). */
export interface RowInput {
  title: string;
  range: string;
  medium: string;
  note: string;
  priority: string;
}

export type RowStatus = "queued" | "error" | "duplicate";

export interface BatchRow {
  /** 1-based physical line where the record starts in the file. */
  line: number;
  input: RowInput;
  /** Values after applying the command defaults (row → --range/--medium/--priority → 全体/null/normal). */
  effective: { range_raw: string; range_label: string | null; range_key: string | null; medium: string | null; priority: Priority };
  status: RowStatus;
  job_id: string | null;
  duplicate_of_line: number | null;
  error: string | null;
  /** Job state (refreshed by refreshBatch); null for error / duplicate rows and before the job exists. */
  state: JobStateName | null;
  work_id: string | null;
  title_resolved: string | null;
  /** Input title ≠ canonical title (compared after the §4.6-1 normalization). */
  correction: boolean;
  /** Job id this row's job was merged into by the queue (state merged). */
  merged_into: string | null;
  /** Short Japanese summary of the row's current / final result. */
  outcome: string;
}

export interface BatchCounts {
  /** Title rows in the file (incl. invalid rows). */
  rows: number;
  /** Jobs enqueued. */
  accepted: number;
  errors: number;
  duplicates: number;
}

/** Live breakdown (refreshBatch). */
export interface BatchProgress {
  pending: number; // received / identifying
  confirmed: number; // identified, input = canonical title
  corrected: number; // identified, input → canonical title
  clarifying: number;
  error: number; // row errors + failed before identification + missing job
  duplicate: number; // in-file duplicates
  cancelled: number; // cancelled before identification
  merged: number; // folded into another job by the queue (also counted in confirmed/corrected when identified)
  terminal: number; // rows whose final outcome is fixed
}

export interface BatchRecord {
  version: 1;
  batch_id: string;
  created_at: string;
  updated_at: string;
  origin: Origin;
  requester: Requester;
  reply_to: string | null;
  file: { name: string; ext: BatchExt; encoding: BatchEncoding; bytes: number; sha256: string; source: string };
  defaults: { range: string | null; medium: string | null; priority: Priority | null };
  limit: number;
  /** false while importBatch is still submitting rows (refreshBatch emits no stage notice before that). */
  import_complete: boolean;
  counts: BatchCounts;
  progress: BatchProgress | null;
  rows: BatchRow[];
  notices: { accepted: string | null; identified: string | null; finished: string | null };
  warnings: string[];
}
