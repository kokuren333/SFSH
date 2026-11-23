/**
 * WP-4.5 batch import (REQUIREMENTS §4.5): decoding (UTF-8 / BOM / CP932, reject otherwise), .txt / .csv (RFC 4180)
 * parsing, row interpretation (defaults, row errors, in-file duplicates), the 200-row limit, and importBatch
 * (same list in five encodings/formats → identical job groups; rejected files enqueue nothing).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeList } from "../src/queue/batch/decode.ts";
import { importBatch, planImport } from "../src/queue/batch/import.ts";
import { parseList, readCsv } from "../src/queue/batch/parse.ts";
import { readBatch } from "../src/queue/batch/record.ts";
import { listNotices } from "../src/queue/notify.ts";
import { comparableRequest } from "../src/queue/request.ts";
import { ensureQueueDirs, findJob, listJobs, type QueueEnv } from "../src/queue/store.ts";
import type { JobRequest } from "../src/queue/types.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "m4");
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const NOW = new Date(2026, 10, 23, 10, 0, 0);
const enc = (s: string) => new TextEncoder().encode(s);

function env(t: { after: (f: () => void) => void }): QueueEnv {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-batch-import-"));
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

function batchDirs(e: QueueEnv): string[] {
  const d = path.join(e.queueDir, "batches");
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

function assertNothingWritten(e: QueueEnv): void {
  assert.deepEqual(batchDirs(e), [], "no batch dir");
  assert.equal(listJobs(e).length, 0, "no job");
  assert.equal(listNotices(e).length, 0, "no notice");
}

// ---------------------------------------------------------------- decoding

test("decode: UTF-8, UTF-8 with BOM and CP932 are told apart and give the same text", () => {
  const a = decodeList(fixture("titles.utf8.txt"));
  const b = decodeList(fixture("titles.utf8bom.txt"));
  const c = decodeList(fixture("titles.cp932.txt"));
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.encoding, "utf-8");
  assert.equal(b.encoding, "utf-8-bom");
  assert.equal(c.encoding, "cp932");
  assert.equal(b.text, a.text);
  assert.equal(c.text.replace(/\r\n/g, "\n"), a.text);
  for (const s of ["魔法少女", "容疑者Ｘの献身", "①", "～", "ﾊｲｷｭｰ"]) assert.ok(c.text.includes(s), s);
  assert.ok(c.text.includes("～"), "CP932 0x8160 decodes to U+FF5E like Python cp932");
});

test("decode: bytes invalid in both UTF-8 and CP932, and control characters, reject the file", () => {
  const u = decodeList(fixture("undecodable.txt"));
  assert.equal(u.ok, false);
  if (!u.ok) assert.match(u.reason, /解読できません/);
  const nul = decodeList(enc("abc\u0000def\n"));
  assert.equal(nul.ok, false);
  if (!nul.ok) assert.match(nul.reason, /U\+0000/);
  // UTF-16LE text is valid UTF-8 full of NULs → rejected, not read as garbage
  assert.equal(decodeList(new Uint8Array(Buffer.from("﻿葬送のフリーレン\n", "utf16le"))).ok, false);
  assert.equal(decodeList(enc("a\u001bb")).ok, false);
  const ok = decodeList(enc("a\tb\r\nc\n"));
  assert.ok(ok.ok && ok.text === "a\tb\r\nc\n");
});

// ---------------------------------------------------------------- parsing

test("txt: whole line is the title, trimmed; blank and # lines skipped; physical line numbers", () => {
  const r = parseList("x.txt", "# c\n\n  A, 1-3巻  \r\n\t# not a title\nB\r\rC");
  assert.ok(r.ok);
  assert.deepEqual(
    r.rows.map((x) => [x.line, x.title, x.range]),
    [
      [3, "A, 1-3巻", ""],
      [5, "B", ""],
      [7, "C", ""],
    ],
  );
});

test("csv: RFC 4180 quoting, escapes, newlines in quotes, CRLF/LF/CR and record line numbers", () => {
  const text = 'title,range\r\n"a, b","1-3巻"\r\n"say ""hi""",\n"multi\r\nline\nfield",2巻\rlast,"x"';
  const r = readCsv(text);
  assert.ok(r.ok);
  assert.deepEqual(r.records, [
    { line: 1, fields: ["title", "range"] },
    { line: 2, fields: ["a, b", "1-3巻"] },
    { line: 3, fields: ['say "hi"', ""] },
    { line: 4, fields: ["multi\r\nline\nfield", "2巻"] },
    { line: 7, fields: ["last", "x"] },
  ]);
  assert.deepEqual(readCsv("a,\n").ok && readCsv("a,\n"), { ok: true, records: [{ line: 1, fields: ["a", ""] }] });
  assert.deepEqual(readCsv('"",""').ok && readCsv('"",""'), { ok: true, records: [{ line: 1, fields: ["", ""] }] });
  // unterminated quote / text after a closing quote → reject
  const u = readCsv('title\n"open\nnever closed\n');
  assert.equal(u.ok, false);
  if (!u.ok) assert.match(u.reason, /閉じていません（2行目から）/);
  const after = readCsv('title\n"a"b\n');
  assert.equal(after.ok, false);
  // through parseList: same rejection
  assert.equal(parseList("x.csv", 'title\n"open').ok, false);
});

test("csv: header required, case-insensitive trimmed names, unknown columns warned, missing title rejected", () => {
  const r = parseList("x.csv", "\n TITLE ,Range, Medium ,NOTE,priority,extra\nA,1巻,manga,n,high,zz\nB\n,,,,\n\n");
  assert.ok(r.ok);
  assert.deepEqual(r.header, ["TITLE", "Range", "Medium", "NOTE", "priority", "extra"]);
  assert.deepEqual(
    r.rows.map((x) => ({ ...x })),
    [
      { line: 3, title: "A", range: "1巻", medium: "manga", note: "n", priority: "high" },
      { line: 4, title: "B", range: "", medium: "", note: "", priority: "" },
    ],
  );
  assert.ok(r.warnings.some((w) => w.includes("extra")));
  const noTitle = parseList("x.csv", "name,range\nA,1巻\n");
  assert.equal(noTitle.ok, false);
  if (!noTitle.ok) assert.match(noTitle.reason, /title 列がありません/);
  assert.equal(parseList("x.csv", "").ok, false);
  assert.equal(parseList("x.csv", "title\n").ok, false, "header only = no title rows");
  assert.equal(parseList("x.tsv", "A\n").ok, false);
  assert.equal(parseList("x", "A\n").ok, false);
  assert.ok(parseList("X.TXT", "A\n").ok, "extension is case-insensitive");
});

test("limit: 200 title rows accepted, 201 rejected (blank / comment / header not counted)", () => {
  const titles = (n: number) => Array.from({ length: n }, (_, i) => `作品${i + 1}`);
  const txt200 = ["# list", "", ...titles(200).flatMap((t, i) => (i % 50 === 0 ? ["", `# ${i}`, t] : [t]))].join("\n");
  const ok = parseList("a.txt", txt200);
  assert.ok(ok.ok && ok.rows.length === 200);
  const over = parseList("a.txt", [...titles(201)].join("\n"));
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.reason, /上限超過.*201/);
  const csv201 = ["title", ...titles(200), ",bad row still counts"].join("\r\n");
  assert.equal(parseList("a.csv", csv201).ok, false, "invalid rows count toward the limit");
  assert.ok(parseList("a.csv", ["title", ...titles(200), ",,", ""].join("\n")).ok, "blank records are not rows");
});

// ---------------------------------------------------------------- importBatch

const FIVE = ["titles.utf8.txt", "titles.utf8bom.txt", "titles.cp932.txt", "titles.utf8.csv", "titles.cp932.csv"];

test("same list as txt/csv in UTF-8 / BOM / CP932 → identical job groups; encoding and source copy recorded", (t) => {
  const e = env(t);
  const groups: { name: string; comparable: unknown[]; rows: unknown[] }[] = [];
  const encodings: Record<string, string> = {};
  for (const [i, name] of FIVE.entries()) {
    const bytes = fixture(name);
    const r = importBatch(e, { fileName: name, bytes, origin: "cli" }, new Date(NOW.getTime() + i * 1000));
    assert.ok(r.ok && !r.dryRun, name);
    const b = r.batch;
    assert.equal(b.batch_id, `B20261123-00${i + 1}`);
    assert.equal(b.counts.rows, 9, name);
    assert.equal(b.counts.accepted, 9, name);
    assert.equal(b.counts.errors + b.counts.duplicates, 0, name);
    encodings[name] = b.file.encoding;
    // source copy = original bytes
    const src = fs.readFileSync(path.join(e.queueDir, "batches", b.batch_id, b.file.source));
    assert.ok(src.equals(Buffer.from(bytes)), name);
    assert.equal(b.file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    const jobs = b.rows.map((row) => {
      const j = findJob(e, row.job_id!)!.job;
      assert.deepEqual(j.batch, { batch_id: b.batch_id, line: row.line });
      return j;
    });
    const strip = (j: JobRequest) => {
      const { batch: _b, ...rest } = comparableRequest(j);
      return rest;
    };
    groups.push({ name, comparable: jobs.map(strip), rows: b.rows.map((r) => [r.input.title, r.effective.range_raw, r.effective.range_key, r.effective.medium, r.effective.priority]) });
  }
  assert.deepEqual(encodings, { "titles.utf8.txt": "utf-8", "titles.utf8bom.txt": "utf-8-bom", "titles.cp932.txt": "cp932", "titles.utf8.csv": "utf-8", "titles.cp932.csv": "cp932" });
  for (const g of groups.slice(1)) {
    assert.deepEqual(g.comparable, groups[0]!.comparable, `${g.name} vs ${groups[0]!.name}`);
    assert.deepEqual(g.rows, groups[0]!.rows, g.name);
  }
  const titles = (groups[0]!.comparable as JobRequest[]).map((j) => j.work_query);
  assert.deepEqual(titles, ["魔法少女まどか☆マギカ", "容疑者Ｘの献身", "葬送のフリーレン", "ゆるキャン△", "進撃の巨人", "STEINS;GATE", "Hello, World ～世界の果てで①～", '"推しの子"', "ﾊｲｷｭｰ!!"]);
  // one batch_accepted per batch, no per-row "received" notice
  const notices = listNotices(e);
  assert.equal(notices.filter((n) => n.kind === "batch_accepted").length, 5);
  assert.equal(notices.filter((n) => n.kind === "received").length, 0);
  assert.equal(listJobs(e).length, 45);
});

test("mixed file: invalid rows recorded as errors, duplicates merged and recorded, the other rows enqueued", (t) => {
  const e = env(t);
  const r = importBatch(e, { fileName: "mixed.csv", bytes: fixture("mixed.csv"), origin: "muse", reply_to: null }, NOW);
  assert.ok(r.ok && !r.dryRun);
  const b = readBatch(e, r.batch.batch_id)!;
  const by = new Map(b.rows.map((x) => [x.line, x]));
  const status = b.rows.map((x) => [x.line, x.status, x.duplicate_of_line]);
  assert.deepEqual(status, [
    [2, "queued", null],
    [3, "error", null],
    [4, "error", null],
    [5, "queued", null],
    [6, "duplicate", 5],
    [7, "queued", null],
    [8, "duplicate", 7],
    [9, "queued", null],
    [10, "error", null],
    [12, "duplicate", 2],
    [13, "queued", null],
    [14, "error", null],
    [15, "queued", null],
  ]);
  assert.match(by.get(3)!.error!, /title が空/);
  assert.match(by.get(4)!.error!, /^invalid range/);
  assert.match(by.get(10)!.error!, /改行/);
  assert.match(by.get(14)!.error!, /priority/);
  assert.deepEqual(b.counts, { rows: 13, accepted: 6, errors: 4, duplicates: 3 });
  assert.ok(b.warnings.some((w) => w.includes("extra")));
  // only queued rows have jobs; error / duplicate rows none
  const jobs = listJobs(e);
  assert.equal(jobs.length, 6);
  for (const row of b.rows) {
    if (row.status === "queued") {
      const j = findJob(e, row.job_id!)!.job;
      assert.equal(j.state, "received");
      assert.equal(j.work_query, row.input.title);
      assert.deepEqual(j.batch, { batch_id: b.batch_id, line: row.line });
      assert.equal(j.origin, "muse");
    } else assert.equal(row.job_id, null);
  }
  const l2 = findJob(e, by.get(2)!.job_id!)!.job;
  assert.equal(l2.options.priority, "high");
  assert.equal(l2.medium_hint, "manga");
  assert.equal(l2.range_raw, "1-3巻");
  assert.equal(by.get(13)!.effective.range_key, "volume:4-4");
  // notes stay in the queue (non-public) — the batch record and the job file
  assert.equal(by.get(2)!.input.note, "非公開メモ");
  // exactly one notice
  const notices = listNotices(e);
  assert.deepEqual(
    notices.map((n) => n.id),
    [`${b.batch_id}.batch_accepted`],
  );
  assert.deepEqual((notices[0]!.data as { counts: unknown }).counts, { rows: 13, accepted: 6, errors: 4, duplicates: 3 });
  assert.match(notices[0]!.text, /投入 6／エラー 4／重複 3/);
  assert.ok(b.notices.accepted);
  assert.equal(b.notices.identified, null);
});

test("over-limit and undecodable files: nothing enqueued, no batch dir, no notice", (t) => {
  const e = env(t);
  const over = ["title,range", ...Array.from({ length: 201 }, (_, i) => `作品${i + 1},`)].join("\n");
  for (const [fileName, bytes] of [
    ["over.csv", enc(over)],
    ["over.txt", enc(Array.from({ length: 201 }, (_, i) => `作品${i + 1}`).join("\n"))],
    ["undecodable.txt", fixture("undecodable.txt")],
    ["bad.csv", enc('title\n"never closed\n')],
    ["notitle.csv", enc("name\nA\n")],
    ["list.xlsx", enc("A\n")],
    ["empty.txt", enc("# only comments\n\n")],
  ] as const) {
    const r = importBatch(e, { fileName, bytes, origin: "cli" }, NOW);
    assert.equal(r.ok, false, fileName);
    if (!r.ok) {
      assert.equal(r.kind, "rejected", fileName);
      assert.match(r.text, /1件も投入していません/);
    }
    assertNothingWritten(e);
  }
  const r = importBatch(e, { fileName: "over.csv", bytes: enc(over), origin: "cli" }, NOW);
  assert.ok(!r.ok && /上限超過/.test(r.reason));
});

test("dry run: interpretation only, nothing written", (t) => {
  const e = env(t);
  const r = importBatch(e, { fileName: "mixed.csv", bytes: fixture("mixed.csv"), origin: "cli", dryRun: true }, NOW);
  assert.ok(r.ok && r.dryRun);
  assert.deepEqual(r.plan.counts, { rows: 13, accepted: 6, errors: 4, duplicates: 3 });
  assert.match(r.text, /dry run/);
  assert.match(r.text, /5行目と重複/);
  assertNothingWritten(e);
  // 200 rows: accepted by the dry run
  const two = planImport({ fileName: "a.txt", bytes: enc(Array.from({ length: 200 }, (_, i) => `作品${i}`).join("\n")), origin: "cli" });
  assert.ok(two.ok && two.plan.counts.accepted === 200);
});

test("defaults: row range/medium/priority → --range/--medium/--priority → 全体/null/normal; bad command options are usage errors", (t) => {
  const e = env(t);
  const csv = "title,range,medium,priority\nA,,,\nB,5巻,novel,normal\nC,,,high\n";
  const r = importBatch(e, { fileName: "d.csv", bytes: enc(csv), origin: "cli", range: "1-3巻", medium: "manga", priority: "high" }, NOW);
  assert.ok(r.ok && !r.dryRun);
  const j = (line: number) => findJob(e, r.batch.rows.find((x) => x.line === line)!.job_id!)!.job;
  assert.deepEqual([j(2).range_raw, j(2).medium_hint, j(2).options.priority], ["1-3巻", "manga", "high"]);
  assert.deepEqual([j(3).range_raw, j(3).medium_hint, j(3).options.priority], ["5巻", "novel", "normal"]);
  assert.deepEqual(r.batch.defaults, { range: "1-3巻", medium: "manga", priority: "high" });
  const plain = importBatch(e, { fileName: "p.txt", bytes: enc("A\n"), origin: "cli" }, NOW);
  assert.ok(plain.ok && !plain.dryRun);
  const pj = findJob(e, plain.batch.rows[0]!.job_id!)!.job;
  assert.deepEqual([pj.range_raw, pj.range, pj.medium_hint, pj.options.priority], ["", [{ unit: "whole", from: null, to: null, label: "全体" }], null, "normal"]);
  assert.equal(plain.batch.batch_id, "B20261123-002");
  const before = listJobs(e).length;
  const bad = importBatch(e, { fileName: "p.txt", bytes: enc("A\n"), origin: "cli", range: "そのへん" }, NOW);
  assert.ok(!bad.ok && bad.kind === "usage");
  const badP = importBatch(e, { fileName: "p.txt", bytes: enc("A\n"), origin: "cli", priority: "urgent" as never }, NOW);
  assert.ok(!badP.ok && badP.kind === "usage");
  assert.equal(listJobs(e).length, before);
  assert.equal(fs.readdirSync(path.join(e.queueDir, "batches")).length, 2);
});

test("duplicates: NFKC / whitespace / range-notation variants merge; different range or medium does not", (t) => {
  const e = env(t);
  const csv = ["title,range,medium", "ＳＰＹ×ＦＡＭＩＬＹ,1-3巻,", "SPY×FAMILY,１〜３巻,", " SPY×FAMILY ,第1巻-第3巻,", "SPY×FAMILY,4巻,", "SPY×FAMILY,1-3巻,anime", "SPY×FAMILY,1-3巻,ANIME"].join("\n");
  const r = planImport({ fileName: "d.csv", bytes: enc(csv), origin: "cli" });
  assert.ok(r.ok);
  assert.deepEqual(
    r.plan.rows.map((x) => [x.line, x.status, x.duplicate_of_line]),
    [
      [2, "queued", null],
      [3, "duplicate", 2],
      [4, "duplicate", 2],
      [5, "queued", null],
      [6, "queued", null],
      [7, "duplicate", 6],
    ],
  );
});
