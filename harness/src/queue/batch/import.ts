/**
 * importBatch (§4.5): decode → parse → interpret rows. A rejected file (undecodable, over the limit, malformed CSV,
 * no title column, unsupported extension) enqueues NOTHING and creates no batch directory. Otherwise:
 * allocate queue/batches/<batch_id>/, keep a copy of the original bytes (source<ext>), submit one job per valid,
 * non-duplicate row in line order (batch ref {batch_id, line}; submitJob sends no per-row notice), write batch.json,
 * emit ONE batch_accepted notice, then refresh once (states that changed meanwhile, or an all-error batch).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../../model/callLog.ts";
import { parseRange } from "../range.ts";
import { localRequester, submitJob } from "../request.ts";
import type { QueueEnv } from "../store.ts";
import type { Origin, Priority, Requester } from "../types.ts";
import { decodeList } from "./decode.ts";
import { parseList } from "./parse.ts";
import { planRows, type PlannedRow } from "./plan.ts";
import { acquireBatchLock, allocateBatchDir, readBatch, writeBatch } from "./record.ts";
import { ensureAcceptedNotice, refreshBatch } from "./refresh.ts";
import { BATCH_LIMIT, showTitle, type BatchCounts, type BatchEncoding, type BatchExt, type BatchRecord } from "./types.ts";

export interface ImportArgs {
  fileName: string;
  bytes: Uint8Array;
  range?: string | null;
  medium?: string | null;
  priority?: Priority | null;
  origin: Origin;
  requester?: Requester;
  reply_to?: string | null;
  dryRun?: boolean;
}

export interface ImportPlan {
  fileName: string;
  ext: BatchExt;
  encoding: BatchEncoding;
  bytes: number;
  sha256: string;
  header: string[] | null;
  defaults: BatchRecord["defaults"];
  counts: BatchCounts;
  rows: PlannedRow[];
  warnings: string[];
}

export type ImportResult =
  | { ok: false; kind: "usage" | "rejected"; reason: string; encoding: BatchEncoding | null; text: string }
  | { ok: true; dryRun: true; plan: ImportPlan; text: string }
  | { ok: true; dryRun: false; plan: ImportPlan; batch: BatchRecord; text: string };

const ORIGINS: Origin[] = ["cli", "muse", "discord"];

function countsOf(rows: PlannedRow[]): BatchCounts {
  return {
    rows: rows.length,
    accepted: rows.filter((r) => r.status === "queued").length,
    errors: rows.filter((r) => r.status === "error").length,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
  };
}

/** Human summary of an interpretation (dry run / CLI). */
export function formatPlan(plan: ImportPlan, batchId: string | null): string {
  const out: string[] = [];
  out.push(
    `${batchId ? `batch ${batchId}` : "dry run（投入しません）"}: ${plan.fileName}（${plan.encoding}、${plan.bytes} bytes）` +
      ` ${plan.counts.rows} 行 → 投入${batchId ? "" : "予定"} ${plan.counts.accepted}／エラー ${plan.counts.errors}／重複 ${plan.counts.duplicates}`,
  );
  for (const r of plan.rows) {
    const what = r.status === "error" ? `エラー: ${r.error}` : r.status === "duplicate" ? `${r.duplicate_of_line}行目と重複（合流）` : `${r.job_id ?? "投入予定"}`;
    const extra = [r.effective.range_label ?? r.effective.range_raw, r.effective.medium, r.effective.priority === "high" ? "priority high" : ""].filter(Boolean).join("、");
    out.push(`  ${String(r.line).padStart(4)}: 「${showTitle(r.input.title)}」${extra ? `（${extra}）` : ""} — ${what}`);
  }
  for (const w of plan.warnings) out.push(`  注意: ${w}`);
  return out.join("\n");
}

function reject(kind: "usage" | "rejected", reason: string, encoding: BatchEncoding | null = null): ImportResult {
  return { ok: false, kind, reason, encoding, text: `${kind === "usage" ? "指定が不正です" : "ファイルを拒否しました（1件も投入していません）"}: ${reason}` };
}

/** Interpretation only (no file system access). */
export function planImport(args: ImportArgs): ImportResult {
  if (!ORIGINS.includes(args.origin)) return reject("usage", `origin が不正です: ${String(args.origin)}`);
  const defRange = (args.range ?? "").trim() || null;
  if (defRange) {
    const p = parseRange(defRange);
    if (!p.ok) return reject("usage", `--range を解釈できません: ${p.reason}`);
  }
  if (args.priority != null && args.priority !== "normal" && args.priority !== "high") return reject("usage", `--priority は normal か high です: ${String(args.priority)}`);
  const defaults = { range: defRange, medium: (args.medium ?? "").trim() || null, priority: args.priority ?? null };
  const dec = decodeList(args.bytes);
  if (!dec.ok) return reject("rejected", dec.reason);
  const parsed = parseList(args.fileName, dec.text, BATCH_LIMIT);
  if (!parsed.ok) return reject("rejected", parsed.reason, dec.encoding);
  const rows = planRows(parsed.rows, defaults, args.origin);
  const plan: ImportPlan = {
    fileName: path.basename(args.fileName.replace(/\\/g, "/")),
    ext: parsed.ext,
    encoding: dec.encoding,
    bytes: args.bytes.byteLength,
    sha256: crypto.createHash("sha256").update(args.bytes).digest("hex"),
    header: parsed.header,
    defaults,
    counts: countsOf(rows),
    rows,
    warnings: parsed.warnings,
  };
  return { ok: true, dryRun: true, plan, text: formatPlan(plan, null) };
}

export function importBatch(env: QueueEnv, args: ImportArgs, now: Date = new Date()): ImportResult {
  const planned = planImport(args);
  if (!planned.ok || args.dryRun) return planned;
  const plan = planned.plan;
  const { batchId } = allocateBatchDir(env, now);
  const release = acquireBatchLock(env, batchId, 60_000);
  if (!release) throw new Error(`could not lock new batch ${batchId}`);
  let rec: BatchRecord;
  try {
    const source = `source${plan.ext}`;
    fs.writeFileSync(path.join(env.queueDir, "batches", batchId, source), args.bytes);
    const at = isoLocal(now);
    rec = {
      version: 1,
      batch_id: batchId,
      created_at: at,
      updated_at: at,
      origin: args.origin,
      requester: args.requester ?? localRequester(),
      reply_to: args.reply_to ?? null,
      file: { name: plan.fileName, ext: plan.ext, encoding: plan.encoding, bytes: plan.bytes, sha256: plan.sha256, source },
      defaults: plan.defaults,
      limit: BATCH_LIMIT,
      import_complete: false,
      counts: plan.counts,
      progress: null,
      rows: plan.rows.map((r) => ({ ...r, effective: { ...r.effective }, input: { ...r.input }, outcome: r.status === "queued" ? "投入中" : r.outcome })),
      notices: { accepted: null, identified: null, finished: null },
      warnings: [...plan.warnings],
    };
    writeBatch(env, rec);
    for (const r of rec.rows) {
      if (r.status !== "queued") continue;
      const sub = submitJob(
        env,
        {
          origin: rec.origin,
          requester: rec.requester,
          reply_to: rec.reply_to,
          work: r.input.title,
          range: r.effective.range_raw,
          medium: r.input.medium || rec.defaults.medium,
          note: r.input.note,
          priority: r.effective.priority,
          batch: { batch_id: batchId, line: r.line },
        },
        now,
      );
      if (sub.ok && sub.job) {
        r.job_id = sub.job.job_id;
        r.state = sub.job.state;
        r.outcome = "受付済み（同定待ち）";
      } else {
        r.status = "error";
        r.error = sub.errors.join("／") || "投入できませんでした";
        r.outcome = `エラー: ${r.error}`;
      }
    }
    rec.counts = countsOf(rec.rows);
    rec.import_complete = true;
    ensureAcceptedNotice(env, rec, now);
    writeBatch(env, rec);
  } finally {
    release();
  }
  refreshBatch(env, batchId, now);
  rec = readBatch(env, batchId) ?? rec;
  const finalPlan: ImportPlan = { ...plan, counts: rec.counts, rows: rec.rows };
  return { ok: true, dryRun: false, plan: finalPlan, batch: rec, text: formatPlan(finalPlan, batchId) };
}
