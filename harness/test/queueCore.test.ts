/**
 * M4 shared core (orchestrator): §4.1 range grammar, JobRequest normalization, queue store (atomic moves,
 * reconcile after a crash, id allocation) and the notification outbox (at most once per id).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatRange, kanjiToNumber, parseRange, rangeKey } from "../src/queue/range.ts";
import { scopeText } from "../src/research/prompts/common.ts";
import { adoptInboxDrops, buildJobRequest, comparableRequest, submitJob, validateJobInput } from "../src/queue/request.ts";
import { allocateJobId, ensureQueueDirs, findJob, listJobs, reconcileDirs, saveJob, type QueueEnv } from "../src/queue/store.ts";
import { emitNotice, listNotices, listPendingNotices, markNoticeSent } from "../src/queue/notify.ts";
import type { Notice } from "../src/queue/types.ts";

function env(t: { after: (f: () => void) => void }): QueueEnv {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-queue-core-"));
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

test("range grammar: the eight §4.1 forms", () => {
  const one = (s: string) => {
    const r = parseRange(s);
    assert.ok(r.ok, `${s}: ${!r.ok ? r.reason : ""}`);
    return r.items;
  };
  assert.deepEqual(one(""), [{ unit: "whole", from: null, to: null, label: "全体" }]);
  assert.deepEqual(one("全体"), [{ unit: "whole", from: null, to: null, label: "全体" }]);
  assert.deepEqual(one("3巻"), [{ unit: "volume", from: 3, to: 3, label: "3巻" }]);
  assert.deepEqual(one("1-3巻"), [{ unit: "volume", from: 1, to: 3, label: "1-3巻" }]);
  assert.deepEqual(one("5話"), [{ unit: "episode", from: 5, to: 5, label: "5話" }]);
  assert.deepEqual(one("1-12話"), [{ unit: "episode", from: 1, to: 12, label: "1-12話" }]);
  assert.deepEqual(one("第2シーズン"), [{ unit: "season", from: 2, to: 2, label: "第2シーズン" }]);
  assert.deepEqual(one("「無限列車」編"), [{ unit: "arc", from: null, to: null, label: "「無限列車」編" }]);
  assert.deepEqual(one("劇場版"), [{ unit: "film", from: null, to: null, label: "劇場版" }]);
});

test("range grammar: variants normalize to the same items", () => {
  const key = (s: string) => {
    const r = parseRange(s);
    assert.ok(r.ok, `${s}: ${!r.ok ? r.reason : ""}`);
    return rangeKey(r.items);
  };
  for (const s of ["1-3巻", "１－３巻", "1〜3巻", "1～3巻", "第1巻-第3巻", "1巻から3巻", "一-三巻", " 1 - 3巻 "]) assert.equal(key(s), "volume:1-3", s);
  for (const s of ["第2シーズン", "シーズン2", "第2期", "2期", "第二シーズン"]) assert.equal(key(s), "season:2-2", s);
  for (const s of ["「無限列車」編", "『無限列車』編", "無限列車編", "「 無限列車 」編"]) assert.equal(key(s), "arc:無限列車編", s);
  assert.equal(key("全12話"), "episode:1-12");
  assert.equal(key("第十二話"), "episode:12-12");
  assert.equal(key("5巻、1-3巻"), key("1-3巻,5巻"));
  assert.equal(key("1-3巻、1-3巻"), "volume:1-3");
  assert.equal(key("劇場版「X の日」"), "film:劇場版xの日");
  const multi = parseRange("1-3巻、5巻");
  assert.equal(formatRange(multi.ok ? multi.items : null), "1-3巻・5巻");
  assert.equal(rangeKey(null), "whole");
});

test("range grammar: unparsable input is rejected with a reason (never silently whole)", () => {
  for (const s of ["3-1巻", "0巻", "1-3", "そのへん", "全体、3巻", "巻", "第巻", "「」編", "1巻、", "100000巻"]) {
    const r = parseRange(s);
    assert.equal(r.ok, false, s);
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
});

test("kanji numerals", () => {
  assert.equal(kanjiToNumber("十二"), 12);
  assert.equal(kanjiToNumber("二十"), 20);
  assert.equal(kanjiToNumber("百五"), 105);
  assert.equal(kanjiToNumber("二〇"), 20);
  assert.equal(kanjiToNumber("千九百九十九"), 1999);
  assert.equal(kanjiToNumber("十十"), null);
  assert.equal(kanjiToNumber("abc"), null);
});

test("JobRequest: CLI and Discord inputs give the same request apart from origin/requester/reply_to", () => {
  const ids = { job_id: "20261123-0100", received_at: "2026-11-23T09:00:00+09:00" };
  const cli = buildJobRequest({ origin: "cli", work: "まどマギ", range: "1-3話", medium: "Anime", note: " n " }, ids);
  const dis = buildJobRequest({ origin: "discord", requester: { id: "42", name: "u" }, reply_to: "chan-1", work: "まどマギ", range: "1-3話", medium: "anime", note: "n" }, ids);
  assert.deepEqual(comparableRequest(cli), comparableRequest(dis));
  assert.equal(cli.state, "received");
  assert.equal(cli.medium_hint, "anime");
  assert.deepEqual(cli.range, [{ unit: "episode", from: 1, to: 3, label: "1-3話" }]);
  const bad = buildJobRequest({ origin: "cli", work: "x", range: "そのへん" }, ids);
  assert.equal(bad.range, null);
  assert.equal(bad.range_raw, "そのへん");
  assert.deepEqual(validateJobInput({ origin: "cli", work: "  " }), ["作品名が空です"]);
});

test("store: submit → inbox, atomic move by state, transition log, reconcile after a crash", (t) => {
  const e = env(t);
  const now = new Date("2026-11-23T09:00:00+09:00");
  const r = submitJob(e, { origin: "cli", work: "A作品", range: "全体" }, now);
  assert.ok(r.ok);
  const id = r.job!.job_id;
  assert.equal(id, "20261123-0001");
  assert.equal(findJob(e, id)!.dir, "inbox");
  const j = r.job!;
  j.state = "queued";
  saveJob(e, j, null, now);
  assert.equal(findJob(e, id)!.dir, "ready");
  assert.ok(!fs.existsSync(path.join(e.queueDir, "inbox", `${id}.json`)));
  const log = fs.readFileSync(path.join(e.jobsDir, `${id}.log`), "utf8");
  assert.match(log, /state received \(inbox\/\)/);
  assert.match(log, /state received -> queued \(inbox\/ -> ready\/\)/);
  // simulated crash: content says running, file still in ready/
  const f = path.join(e.queueDir, "ready", `${id}.json`);
  const crashed = { ...JSON.parse(fs.readFileSync(f, "utf8")), state: "researching" };
  fs.writeFileSync(f, JSON.stringify(crashed));
  assert.deepEqual(reconcileDirs(e, now), [`${id}: ready -> running`]);
  assert.equal(findJob(e, id)!.dir, "running");
  // duplicate copy (older) is dropped
  fs.writeFileSync(path.join(e.queueDir, "ready", `${id}.json`), JSON.stringify({ ...crashed, state: "queued", updated_at: "2026-01-01T00:00:00+09:00" }));
  reconcileDirs(e, now);
  assert.equal(listJobs(e).length, 1);
  assert.equal(findJob(e, id)!.job.state, "researching");
});

test("store: job ids are unique under concurrent allocation and skip ids used by old state files", (t) => {
  const e = env(t);
  const now = new Date("2026-11-23T09:00:00+09:00");
  fs.writeFileSync(path.join(e.jobsDir, "20261123-0005.state.json"), "{}");
  const ids = Array.from({ length: 20 }, () => allocateJobId(e, now));
  assert.equal(new Set(ids).size, 20);
  assert.equal(ids[0], "20261123-0006");
});

test("inbox drops (Muse §4.3): foreign JSON is adopted through the same normalizer; invalid ones are set aside", (t) => {
  const e = env(t);
  const now = new Date("2026-11-23T09:00:00+09:00");
  fs.writeFileSync(path.join(e.queueDir, "inbox", "from-muse.json"), JSON.stringify({ work: "まどマギ", range: "1-3話", medium: "anime" }));
  fs.writeFileSync(path.join(e.queueDir, "inbox", "broken.json"), "{");
  const r = adoptInboxDrops(e, now);
  assert.equal(r.adopted.length, 1);
  assert.equal(r.adopted[0].origin, "muse");
  assert.deepEqual(r.rejected.map((x) => x.file), ["broken.json"]);
  const viaCli = buildJobRequest({ origin: "cli", work: "まどマギ", range: "1-3話", medium: "anime" }, { job_id: "x", received_at: "y" });
  assert.deepEqual(comparableRequest(r.adopted[0]), comparableRequest(viaCli));
  assert.ok(fs.readdirSync(path.join(e.queueDir, "inbox", "_adopted")).length === 1);
  assert.ok(fs.readdirSync(path.join(e.queueDir, "inbox", "_rejected")).length === 1);
});

test("outbox: a notice id is written once, even after it was sent", (t) => {
  const e = env(t);
  const n: Notice = { id: "20261123-0001.completed", at: "2026-11-23T09:00:00+09:00", kind: "completed", job_id: "20261123-0001", batch_id: null, origin: "discord", reply_to: "c", text: "完了", data: {} };
  assert.equal(emitNotice(e, n), true);
  assert.equal(emitNotice(e, n), false);
  assert.equal(listPendingNotices(e).length, 1);
  markNoticeSent(e, n.id, "test");
  assert.equal(listPendingNotices(e).length, 0);
  assert.equal(emitNotice(e, n), false);
  const all = listNotices(e, { job_id: "20261123-0001" });
  assert.equal(all.length, 1);
  assert.equal(all[0].sent_via, "test");
  assert.throws(() => emitNotice(e, { ...n, id: "../x" }));
});

test("range grammar (A16): N作目 parses as an installment selector", () => {
  const one = (s: string) => {
    const r = parseRange(s);
    assert.ok(r.ok, `${s}: ${!r.ok ? r.reason : ""}`);
    return r.items;
  };
  assert.deepEqual(one("2作目"), [{ unit: "installment", from: 2, to: 2, label: "2作目" }]);
  assert.deepEqual(one("第3作目"), [{ unit: "installment", from: 3, to: 3, label: "3作目" }]);
  assert.deepEqual(one("二作目"), [{ unit: "installment", from: 2, to: 2, label: "2作目" }]);
  assert.equal(rangeKey(one("2作目")), "installment:2-2");
  assert.equal(formatRange(one("2作目")), "2作目");
});

test("scopeText (A16): a partial range becomes a scope instruction; whole / installment do not", () => {
  assert.equal(scopeText([{ unit: "whole", from: null, to: null, label: "全体" }]), null);
  assert.equal(scopeText([{ unit: "installment", from: 2, to: 2, label: "2作目" }]), null);
  assert.equal(scopeText(null), null);
  const arc = scopeText([{ unit: "arc", from: null, to: null, label: "「ハンター試験」編" }]);
  assert.ok(arc && arc.includes("「ハンター試験」編") && arc.includes("対象外"));
  const vol = scopeText([{ unit: "volume", from: 1, to: 3, label: "1-3巻" }]);
  assert.ok(vol && vol.includes("1-3巻"));
});
