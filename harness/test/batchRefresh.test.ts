/**
 * WP-4.5 batch record and notices (REQUIREMENTS §4.5): refreshBatch follows the jobs (driven here by hand with
 * saveJob, the way the worker will move them) and emits exactly one batch_accepted / batch_identified /
 * batch_finished per batch — also when called many times and after a simulated restart. Plus status, cancel,
 * crash recovery of an interrupted import, the lock, and the `sfsh import` command.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { importCommand } from "../src/commands/import.ts";
import { importBatch } from "../src/queue/batch/import.ts";
import { acquireBatchLock, batchDir, readBatch, writeBatch } from "../src/queue/batch/record.ts";
import { refreshAllBatches, refreshBatch, refreshBatchForJob } from "../src/queue/batch/refresh.ts";
import { batchStatus, cancelBatch } from "../src/queue/batch/status.ts";
import type { BatchRecord } from "../src/queue/batch/types.ts";
import { listNotices, markNoticeSent } from "../src/queue/notify.ts";
import { ensureQueueDirs, findJob, listJobs, saveJob, type QueueEnv } from "../src/queue/store.ts";
import type { Actor, ClarifyInfo, JobRequest, JobStateName, Notice, OpResult } from "../src/queue/types.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "m4");
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const enc = (s: string) => new TextEncoder().encode(s);
let clock = new Date(2026, 10, 23, 9, 0, 0).getTime();
const tick = () => new Date((clock += 1000));

function env(t: { after: (f: () => void) => void }): QueueEnv {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-batch-refresh-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const e: QueueEnv = {
    queueDir: path.join(tmp, "queue"),
    jobsDir: path.join(tmp, "jobs"),
    worksDir: path.join(tmp, "works"),
    ledgerPath: path.join(tmp, "LEDGER.md"),
    siteOut: path.join(tmp, "dist"),
  };
  ensureQueueDirs(e);
  return e;
}

function importMixed(e: QueueEnv): BatchRecord {
  const r = importBatch(e, { fileName: "mixed.csv", bytes: fixture("mixed.csv"), origin: "discord", requester: { id: "u1", name: "owner" }, reply_to: "chan-1" }, tick());
  assert.ok(r.ok && !r.dryRun);
  return r.batch;
}

function jobOfLine(e: QueueEnv, b: BatchRecord, line: number): JobRequest {
  const row = b.rows.find((r) => r.line === line)!;
  return findJob(e, row.job_id!)!.job;
}

/** Move a job like the worker would, then call the hook. */
function drive(e: QueueEnv, job: JobRequest, state: JobStateName, patch: Partial<JobRequest> = {}): void {
  const j = { ...findJob(e, job.job_id)!.job, ...patch, state };
  const now = tick();
  saveJob(e, j, null, now);
  refreshBatchForJob(e, j, now);
}

function resolved(workId: string, title: string) {
  return { work_id: workId, title, title_status: "confirmed" as const, method: "research" as const, source_ids: ["S1"], alias_recorded: true, resolved_at: "2026-11-23T09:00:00+09:00" };
}

function clarify(message: string, n: number): ClarifyInfo {
  return {
    reason: n ? "multiple_candidates" : "no_candidates",
    asked_at: "2026-11-23T09:00:00+09:00",
    message,
    candidates: Array.from({ length: n }, (_, i) => ({ title: `候補${i + 1}の題名`, medium: "manga", first_release_year: 2000 + i, work_id: null, creators: [`作者${i + 1}`] })),
  };
}

const batchNotices = (e: QueueEnv, id: string, kind?: string): Notice[] => listNotices(e, { batch_id: id }).filter((n) => !kind || n.kind === kind);

test("refreshBatch: one batch_accepted, one batch_identified (all clarifying rows + corrections), one batch_finished", (t) => {
  const e = env(t);
  const b = importMixed(e);
  const id = b.batch_id;
  assert.equal(batchNotices(e, id).length, 1);
  assert.equal(batchNotices(e, id, "batch_accepted").length, 1);
  assert.equal(batchNotices(e, id)[0]!.reply_to, "chan-1");
  // queued rows: 2, 5, 7, 9, 13, 15
  const [j2, j5, j7, j9, j13, j15] = [2, 5, 7, 9, 13, 15].map((l) => jobOfLine(e, b, l));
  drive(e, j2!, "identifying");
  for (let i = 0; i < 3; i++) refreshBatch(e, id, tick());
  assert.equal(batchNotices(e, id).length, 1, "nothing while rows are received / identifying");

  drive(e, j2!, "queued", { resolved: resolved("w-frieren", "葬送のフリーレン") });
  drive(e, j5!, "identifying");
  drive(e, j5!, "queued", { resolved: resolved("w-steins", "STEINS;GATE") }); // ＳＴＥＩＮＳ；ＧＡＴＥ → same after NFKC: not a correction
  drive(e, j7!, "queued", { resolved: resolved("w-hagaren", "鋼の錬金術師") }); // "鋼の  錬金術師" → correction
  drive(e, j9!, "clarifying", { clarify: clarify("候補が複数あります", 2) });
  drive(e, j13!, "merged", { resolved: resolved("w-frieren", "葬送のフリーレン"), merged_into: "20261101-0001" }); // existing job outside the batch
  assert.equal(batchNotices(e, id, "batch_identified").length, 0, "row 15 still received");
  drive(e, j15!, "clarifying", { clarify: clarify("候補が見つかりません。作品名を確かめてください", 0) });

  const ids = batchNotices(e, id, "batch_identified");
  assert.equal(ids.length, 1);
  const n = ids[0]!;
  assert.equal(n.id, `${id}.batch_identified`);
  assert.equal(n.reply_to, "chan-1");
  assert.equal(n.origin, "discord");
  assert.match(n.text, /確定 3／表記を正式名称へ補正 1／聞き返し中 2／エラー 4/);
  assert.match(n.text, /7行目: 入力『鋼の {2}錬金術師』→ 正式名称『鋼の錬金術師』/);
  assert.match(n.text, /9行目「架空の曖昧作品X」/);
  assert.match(n.text, /1\. 候補1の題名（manga、2000年、作者1）/);
  assert.match(n.text, /2\. 候補2の題名/);
  assert.match(n.text, /15行目「容疑者Ｘの献身」.*候補が見つかりません/);
  assert.match(n.text, /3行目「\(空\)」: title が空です/);
  assert.match(n.text, /4行目「進撃の巨人」: invalid range/);
  const data = n.data as { breakdown: Record<string, number>; clarifying: { line: number; candidates: unknown[] }[]; corrections: { line: number }[] };
  assert.deepEqual(data.breakdown, { confirmed: 3, corrected: 1, clarifying: 2, error: 4, duplicate: 3, cancelled: 0, merged: 1 });
  assert.deepEqual(
    data.clarifying.map((c) => [c.line, c.candidates.length]),
    [
      [9, 2],
      [15, 0],
    ],
  );
  assert.deepEqual(
    data.corrections.map((c) => c.line),
    [7],
  );

  // many refreshes / an answer that re-identifies a clarifying row → still exactly one
  for (let i = 0; i < 5; i++) refreshBatch(e, id, tick());
  drive(e, j15!, "received", { clarify: null });
  drive(e, j15!, "identifying");
  drive(e, j15!, "queued", { resolved: resolved("w-x", "容疑者Xの献身") });
  assert.equal(batchNotices(e, id, "batch_identified").length, 1);

  // simulated restart: notice delivered (sent/), batch.json lost its notice stamps → no second notice
  markNoticeSent(e, `${id}.batch_identified`, "test");
  const rec = readBatch(e, id)!;
  rec.notices.identified = null;
  writeBatch(e, rec);
  refreshAllBatches(e, tick());
  assert.equal(batchNotices(e, id, "batch_identified").length, 1);
  assert.ok(readBatch(e, id)!.notices.identified, "stamp restored");

  // record follows the jobs
  let r = readBatch(e, id)!;
  const row = (l: number) => r.rows.find((x) => x.line === l)!;
  assert.equal(row(7).correction, true);
  assert.equal(row(7).title_resolved, "鋼の錬金術師");
  assert.equal(row(5).correction, false);
  assert.equal(row(8).title_resolved, "鋼の錬金術師", "duplicate row follows its first row");
  assert.equal(row(13).merged_into, "20261101-0001");
  assert.equal(row(13).state, "merged");
  assert.match(row(9).outcome, /聞き返し中/);
  assert.equal(row(15).state, "queued");

  // to the end
  drive(e, j2!, "researching");
  drive(e, j2!, "built");
  drive(e, j5!, "failed", { error: "stage research failed 3 times" });
  drive(e, j7!, "held");
  drive(e, j9!, "cancelled", { cancel_requested: { at: "x", by: { id: "u1", name: "owner" }, origin: "discord" } });
  assert.equal(batchNotices(e, id, "batch_finished").length, 0, "row 15 not terminal yet");
  drive(e, j15!, "building");
  drive(e, j15!, "built");
  const fin = batchNotices(e, id, "batch_finished");
  assert.equal(fin.length, 1);
  assert.match(fin[0]!.text, /完了 2／合流 1／失敗 1／保留 1／取消 1／エラー 4／ファイル内重複 3/);
  assert.match(fin[0]!.text, /5行目「ＳＴＥＩＮＳ；ＧＡＴＥ」.*失敗.*stage research failed/);
  for (let i = 0; i < 5; i++) refreshBatch(e, id, tick());
  refreshAllBatches(e, tick());
  r = readBatch(e, id)!;
  assert.ok(r.notices.finished);
  assert.equal(r.progress!.terminal, 13);
  assert.match(row(2).outcome, /完了「葬送のフリーレン」/);
  // overall: exactly one notice per stage, nothing per row
  assert.deepEqual(
    batchNotices(e, id).map((x) => x.kind).sort(),
    ["batch_accepted", "batch_finished", "batch_identified"],
  );
  assert.equal(listNotices(e).length, 3);
});

test("all rows invalid: the three stage notices are still one each, sent at import", (t) => {
  const e = env(t);
  const r = importBatch(e, { fileName: "bad.csv", bytes: enc("title,range\n,1巻\nA,そのへん\n"), origin: "cli" }, tick());
  assert.ok(r.ok && !r.dryRun);
  assert.equal(listJobs(e).length, 0);
  const id = r.batch.batch_id;
  assert.deepEqual(batchNotices(e, id).map((n) => n.kind).sort(), ["batch_accepted", "batch_finished", "batch_identified"]);
  refreshBatch(e, id, tick());
  assert.equal(batchNotices(e, id).length, 3);
  assert.ok(r.batch.notices.finished);
});

test("batchStatus: rows with line, input title, state, canonical title, outcome", (t) => {
  const e = env(t);
  const b = importMixed(e);
  drive(e, jobOfLine(e, b, 7), "queued", { resolved: resolved("w-hagaren", "鋼の錬金術師") });
  const s = batchStatus(e, b.batch_id);
  assert.ok(s.ok);
  const rows = (s.data as { rows: { line: number; title: string; state: string | null; title_resolved: string | null; outcome: string }[] }).rows;
  assert.equal(rows.length, 13);
  const r7 = rows.find((r) => r.line === 7)!;
  assert.deepEqual([r7.title, r7.state, r7.title_resolved], ["鋼の  錬金術師", "queued", "鋼の錬金術師"]);
  assert.match(s.text, /『鋼の錬金術師』/);
  assert.match(s.text, /エラー/);
  assert.equal(batchStatus(e, "B20990101-001").ok, false);
  assert.equal(batchStatus(e, "../etc").ok, false);
});

test("cancelBatch: only unfinished rows go through the injected cancel; requester or owner only", (t) => {
  const e = env(t);
  const r = importBatch(e, { fileName: "titles.utf8.txt", bytes: fixture("titles.utf8.txt"), origin: "discord", requester: { id: "u2", name: "member" }, reply_to: "c" }, tick());
  assert.ok(r.ok && !r.dryRun);
  const b = r.batch;
  const jobs = b.rows.map((row) => findJob(e, row.job_id!)!.job);
  drive(e, jobs[0]!, "built", { resolved: resolved("w1", "魔法少女まどか☆マギカ") });
  drive(e, jobs[1]!, "failed");
  drive(e, jobs[2]!, "researching", { resolved: resolved("w3", "葬送のフリーレン") });
  drive(e, jobs[3]!, "clarifying", { clarify: clarify("候補が複数", 2) });
  const calls: string[] = [];
  const cancelJob = (jobId: string): OpResult => {
    calls.push(jobId);
    const j = findJob(e, jobId)!.job;
    if (j.state === "researching") {
      saveJob(e, { ...j, cancel_requested: { at: "now", by: { id: "u2", name: "member" }, origin: "discord" } }, null, tick());
      return { ok: true, text: "取消を要求しました（段の境界で止まります）" };
    }
    saveJob(e, { ...j, state: "cancelled" }, null, tick());
    return { ok: true, text: "取消しました" };
  };
  const stranger: Actor = { id: "u9", name: "x", origin: "discord", is_owner: false };
  const refused = cancelBatch(e, b.batch_id, stranger, cancelJob, tick());
  assert.equal(refused.ok, false);
  assert.equal(calls.length, 0);
  const member: Actor = { id: "u2", name: "member", origin: "discord", is_owner: false };
  const res = cancelBatch(e, b.batch_id, member, cancelJob, tick());
  assert.ok(res.ok, res.text);
  assert.deepEqual(calls, jobs.slice(2).map((j) => j.job_id), "built / failed rows are not touched");
  const d = res.data as { cancelled: unknown[]; skipped: unknown[] };
  assert.equal(d.cancelled.length, 7);
  assert.equal(d.skipped.length, 2);
  assert.match(res.text, /取消 7／取消できず 0／対象外 2/);
  const rec = readBatch(e, b.batch_id)!;
  assert.equal(rec.rows.filter((x) => x.state === "cancelled").length, 6);
  // the running row is not terminal yet → no batch_finished
  assert.equal(batchNotices(e, b.batch_id, "batch_finished").length, 0);
  drive(e, jobs[2]!, "cancelled");
  assert.equal(batchNotices(e, b.batch_id, "batch_finished").length, 1);
  // owner may cancel; nothing left to cancel
  calls.length = 0;
  const again = cancelBatch(e, b.batch_id, { id: "local", name: "o", origin: "cli", is_owner: true }, cancelJob, tick());
  assert.ok(again.ok);
  assert.equal(calls.length, 0);
});

test("interrupted import (importer died holding the lock): jobs adopted, the rest marked as errors, notices once", (t) => {
  const e = env(t);
  const r = importBatch(e, { fileName: "titles.utf8.txt", bytes: fixture("titles.utf8.txt"), origin: "cli" }, tick());
  assert.ok(r.ok && !r.dryRun);
  const id = r.batch.batch_id;
  // rewind batch.json to "mid-import": rows 1–3 submitted but not yet recorded, the last row never submitted
  const rec = readBatch(e, id)!;
  const last = rec.rows[rec.rows.length - 1]!;
  const lastJob = findJob(e, last.job_id!)!;
  fs.rmSync(lastJob.file);
  for (const row of rec.rows.slice(0, 3)) row.job_id = null;
  last.job_id = null;
  rec.import_complete = false;
  rec.notices = { accepted: null, identified: null, finished: null };
  writeBatch(e, rec);
  // a stale lock of a dead importer
  fs.mkdirSync(path.join(batchDir(e, id), ".lock"));
  fs.writeFileSync(path.join(batchDir(e, id), ".lock", "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  const res = refreshBatch(e, id, tick());
  assert.ok(res.ok, res.reason ?? "");
  const after = readBatch(e, id)!;
  assert.equal(after.import_complete, true);
  assert.deepEqual(
    after.rows.slice(0, 3).map((x) => x.job_id),
    r.batch.rows.slice(0, 3).map((x) => x.job_id),
  );
  const lr = after.rows[after.rows.length - 1]!;
  assert.equal(lr.status, "error");
  assert.match(lr.error!, /中断/);
  assert.equal(after.counts.accepted, 8);
  assert.equal(batchNotices(e, id, "batch_accepted").length, 1, "accepted notice not duplicated");
  assert.ok(after.notices.accepted);
  assert.ok(!fs.existsSync(path.join(batchDir(e, id), ".lock")), "lock released");
});

test("lock: a held lock blocks a second taker until released (dead holders: see the interrupted-import test)", (t) => {
  const e = env(t);
  const r = importBatch(e, { fileName: "a.txt", bytes: enc("A\n"), origin: "cli" }, tick());
  assert.ok(r.ok && !r.dryRun);
  const release = acquireBatchLock(e, r.batch.batch_id)!;
  assert.ok(release);
  assert.equal(acquireBatchLock(e, r.batch.batch_id, 50), null);
  release();
  const again = acquireBatchLock(e, r.batch.batch_id, 50);
  assert.ok(again);
  again!();
});

test("refreshBatchForJob: no-op for single jobs, never throws for a missing batch", (t) => {
  const e = env(t);
  assert.equal(refreshBatchForJob(e, { batch: null }), null);
  const res = refreshBatchForJob(e, { batch: { batch_id: "B20261123-999", line: 1 } });
  assert.equal(res!.ok, false);
  const bad = refreshBatchForJob(e, { batch: { batch_id: "nope", line: 1 } });
  assert.equal(bad!.ok, false);
});

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const log = console.log;
  const error = console.error;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
  try {
    return { code: await fn(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("sfsh import: exit 0 / 2 usage / 3 rejected; --dry-run --json writes nothing", async (t) => {
  const e = env(t);
  const now = () => tick();
  const dry = await capture(() => importCommand([path.join(FIX, "mixed.csv"), "--dry-run", "--json"], e, now));
  assert.equal(dry.code, 0);
  const j = JSON.parse(dry.out) as { ok: boolean; dry_run: boolean; plan: { counts: unknown } };
  assert.deepEqual([j.ok, j.dry_run, j.plan.counts], [true, true, { rows: 13, accepted: 6, errors: 4, duplicates: 3 }]);
  assert.equal(listJobs(e).length, 0);
  const ok = await capture(() => importCommand([path.join(FIX, "titles.cp932.csv"), "--range", "1巻", "--priority", "--origin", "muse"], e, now));
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /batch B\d{8}-001: titles\.cp932\.csv（cp932/);
  const jobs = listJobs(e).map((l) => l.job);
  assert.equal(jobs.length, 9);
  assert.ok(jobs.every((x) => x.range_raw === "1巻" && x.options.priority === "high" && x.origin === "muse"));
  const rej = await capture(() => importCommand([path.join(FIX, "undecodable.txt")], e, now));
  assert.equal(rej.code, 3);
  assert.match(rej.err, /1件も投入していません/);
  assert.equal((await capture(() => importCommand([], e, now))).code, 2);
  assert.equal((await capture(() => importCommand(["x.txt", "--bogus"], e, now))).code, 2);
  assert.equal((await capture(() => importCommand([path.join(FIX, "titles.utf8.txt"), "--priority", "urgent"], e, now))).code, 2);
  assert.equal((await capture(() => importCommand([path.join(FIX, "titles.utf8.txt"), "--range", "そのへん"], e, now))).code, 2);
  assert.equal((await capture(() => importCommand([path.join(FIX, "no-such-file.txt")], e, now))).code, 2);
  assert.equal(listJobs(e).length, 9);
});
