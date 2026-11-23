/**
 * M4 gate tests (orchestrator, CP-038): the cross-package paths that no single worker package covers.
 *  1. Discord → real SfshService → queue file  ==  CLI `sfsh enqueue` → queue file (comparableRequest), and a stranger /
 *     a non-owner hold leave no file behind.
 *  2. Batch (§4.5) through the REAL worker in child processes: a mixed list (invalid row, invalid range, duplicate,
 *     ambiguous title) — other rows are not stopped, batch.json keeps every row's outcome, the worker is SIGKILLed in
 *     the middle of the batch and a new worker finishes it, and every batch stage notice exists exactly once.
 *  3. release puts held queue jobs back to queued and the worker finishes them (CP-038 decision).
 *  4. A long notice (one batch_identified) is posted as several Discord messages but stays one notice.
 * Temp dirs only, fake ports (no model call), injected build, 127.0.0.1 only.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { enqueueCommand } from "../src/commands/queue.ts";
import { handleInteraction } from "../src/discord/handler.ts";
import { createNotifierState, deliverNotices, splitForDiscord } from "../src/discord/notifier.ts";
import { interaction, memLog, MEMBER, OWNER, STRANGER, testConfig } from "../src/discord/testkit.ts";
import { readState } from "../src/job/runner.ts";
import { importBatch } from "../src/queue/batch/import.ts";
import { readBatch } from "../src/queue/batch/record.ts";
import { emitNotice, listNotices, listPendingNotices } from "../src/queue/notify.ts";
import { answerJob } from "../src/queue/ops.ts";
import { comparableRequest } from "../src/queue/request.ts";
import { createSfshService } from "../src/queue/service.ts";
import { findJob, listJobs, saveJob } from "../src/queue/store.ts";
import type { Actor } from "../src/queue/types.ts";
import { runWorker } from "../src/queue/worker.ts";
import { readWork, writeWork } from "../src/works/store.ts";
import { childDeps, makeEnv, markerCounts, seedWork } from "./e2e/workerChild.ts";

const OWNER_CLI: Actor = { id: "local", name: "owner", origin: "cli", is_owner: true };
const CHILD = path.join(import.meta.dirname!, "e2e", "workerChild.ts");

function tmp(t: { after: (f: () => void) => void }, prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// ------------------------------------------------------------------ 1. CLI and Discord → the same JobRequest

test("gate: CLI enqueue and Discord /sfsh request (real service) write the same JobRequest; strangers and non-owner ops write nothing", async (t) => {
  const env = makeEnv(tmp(t, "sfsh-m4gate-1-"));
  const service = createSfshService(env);
  const log = memLog();
  const ctx = { cfg: testConfig(), service, log, fetchAttachment: async () => new Uint8Array() };
  const cases = [
    { work: "魔法少女まどか☆マギカ", range: "1-3話", medium: "anime", note: "テスト" },
    { work: "容疑者Xの献身", range: "全体", medium: "novel", note: "" },
    { work: "ある作品", range: "そのへん", medium: "", note: "" }, // unparsable range → range null, clarifying later
  ];
  for (const c of cases) {
    const before = new Set(listJobs(env).map((l) => l.job.job_id));
    const opts: Record<string, string> = { work: c.work, range: c.range };
    if (c.medium) opts.medium = c.medium;
    if (c.note) opts.note = c.note;
    const reply = await handleInteraction(interaction(MEMBER, "request", opts), ctx);
    assert.ok(reply && !reply.ephemeral, reply?.content ?? "no reply");
    const viaDiscord = listJobs(env).map((l) => l.job).find((j) => !before.has(j.job_id))!;
    assert.equal(viaDiscord.origin, "discord");
    assert.equal(viaDiscord.requester.id, MEMBER.id);
    const args = ["--work", c.work, "--range", c.range, ...(c.medium ? ["--medium", c.medium] : []), ...(c.note ? ["--note", c.note] : []), "--json"];
    const origLog = console.log;
    console.log = () => {};
    try {
      assert.equal(await enqueueCommand(args, env), 0);
    } finally {
      console.log = origLog;
    }
    const viaCli = listJobs(env).map((l) => l.job).find((j) => !before.has(j.job_id) && j.job_id !== viaDiscord.job_id)!;
    assert.equal(viaCli.origin, "cli");
    assert.deepEqual(comparableRequest(viaDiscord), comparableRequest(viaCli), c.work);
  }
  // stranger: nothing written, rejection recorded
  const n = listJobs(env).length;
  await handleInteraction(interaction(STRANGER, "request", { work: "x", range: "全体" }), ctx);
  assert.equal(listJobs(env).length, n);
  assert.equal(log.records.at(-1)!.reason, "not_allowed");
  // allowed non-owner: hold refused before the service; owner: allowed (unknown work → service says so)
  seedWork(env, { work_id: "novel-gate-sakuhin-2001", title: "門の作品", medium: "novel" });
  await handleInteraction(interaction(MEMBER, "hold", { work: "novel-gate-sakuhin-2001", reason: "r" }), ctx);
  assert.equal(log.records.at(-1)!.reason, "owner_only");
  assert.equal(readWork(path.join(env.worksDir, "novel-gate-sakuhin-2001")).publish_mode, "Public");
  const ok = await handleInteraction(interaction(OWNER, "hold", { work: "novel-gate-sakuhin-2001", reason: "gate" }), ctx);
  assert.match(ok!.content, /Restricted/);
  assert.equal(readWork(path.join(env.worksDir, "novel-gate-sakuhin-2001")).publish_mode, "Restricted");
  // service-level second layer: a non-owner actor cannot hold even if the bot layer were bypassed
  const direct = await service.hold("novel-gate-sakuhin-2001", null, { id: MEMBER.id, name: "m", origin: "discord", is_owner: false });
  assert.equal(direct.ok, false);
});

// ------------------------------------------------------------------ 2. batch through the worker, SIGKILL, resume

function startChild(root: string): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, [CHILD, root], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  const done = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  done.then(() => err && process.stderr.write(`[child stderr] ${err}\n`));
  return { child, done };
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("gate (§7.4 M4): a mixed batch runs through the worker; SIGKILL mid-batch → a new worker continues; batch.json keeps every outcome; one notice per stage", async (t) => {
  const root = tmp(t, "sfsh-m4gate-2-");
  const env = makeEnv(root);
  seedWork(env, { work_id: "novel-hoshifuru-toudai-2001", title: "星降る灯台", medium: "novel", title_reading: "ほしふる とうだい" });
  seedWork(env, { work_id: "manga-kaze-no-toshokan-2010", title: "風の図書館", medium: "manga", title_reading: "かぜの としょかん" });
  // two works share the alias 灯台物語 → identification asks back (multiple_index_matches)
  const alias = (text: string) => ({ text, kind: "common" as const, attested: true, source_ids: [], origin_job_id: "", first_seen: "2026-01-01T00:00:00+09:00" });
  seedWork(env, { work_id: "film-toudai-monogatari-1990", title: "灯台物語", medium: "film", aliases: [] });
  seedWork(env, { work_id: "novel-shin-toudai-monogatari-2015", title: "新・灯台物語", medium: "novel", aliases: [alias("灯台物語")] });

  const csv = [
    "title,range,medium,note",
    "星降る灯台,全体,,",
    "風の図書館,1-3巻,manga,",
    ",全体,,", // empty title → row error
    "　星降る灯台　,全体,,", // duplicate of line 2 after normalization (NFKC + trim)
    "風の図書館,そのへん,,", // invalid range → row error
    "灯台物語,全体,,", // ambiguous → clarifying
  ].join("\r\n");
  const imp = importBatch(env, { fileName: "gate.csv", bytes: new TextEncoder().encode(csv), origin: "cli", reply_to: null }, new Date());
  assert.ok(imp.ok && !imp.dryRun, imp.text);
  const batchId = imp.batch.batch_id;
  assert.deepEqual(imp.batch.counts, { rows: 6, accepted: 3, errors: 2, duplicates: 1 });

  // worker 1: identifies all rows first, then dies inside `fact` of the first main job
  const w1 = startChild(root);
  await waitFor(() => fs.existsSync(path.join(root, "markers", "fact.txt")), 20_000, "first worker inside fact");
  const midIdentified = listNotices(env, { batch_id: batchId }).filter((n) => n.kind === "batch_identified");
  assert.equal(midIdentified.length, 1, "identification of every row finished before main processing (one batch_identified)");
  w1.child.kill("SIGKILL");
  await w1.done;
  assert.ok(fs.existsSync(path.join(env.queueDir, "worker.lock")), "stale lock left by the killed worker");
  const running = listJobs(env, ["running"]);
  assert.equal(running.length, 1, "one job was mid-pipeline when killed");
  const killedJob = running[0]!.job.job_id;

  // worker 2: takes over, resumes the killed job from `fact`, processes the other row
  const w2 = startChild(root);
  assert.equal(await w2.done, 0);
  const m = markerCounts(root);
  assert.equal(m.search_r1, 2, "two main jobs, each ran search_r1 once (no re-run after the kill)");
  assert.equal(m.fact, 3, "fact: killed run + resumed run + the other job");
  assert.equal(readState(env.jobsDir, killedJob).stages.fact.attempts, 2);
  assert.match(fs.readFileSync(path.join(env.jobsDir, `${killedJob}.log`), "utf8"), /worker recovery: stage fact@attempt1 was running/);

  let rec = readBatch(env, batchId)!;
  const byLine = new Map(rec.rows.map((r) => [r.line, r]));
  assert.equal(byLine.get(2)!.state, "built");
  assert.equal(byLine.get(3)!.state, "built");
  assert.equal(byLine.get(4)!.status, "error");
  assert.equal(byLine.get(5)!.status, "duplicate");
  assert.equal(byLine.get(6)!.status, "error");
  assert.equal(byLine.get(7)!.state, "clarifying");
  let kinds = listNotices(env, { batch_id: batchId }).map((n) => n.kind).sort();
  assert.deepEqual(kinds, ["batch_accepted", "batch_identified"], "no batch_finished while a row is still being asked back");
  assert.match(listNotices(env, { batch_id: batchId }).find((n) => n.kind === "batch_identified")!.text, /灯台物語/);

  // answer the clarifying row (pick 1) and run a worker again → the batch finishes
  const clar = findJob(env, byLine.get(7)!.job_id!)!.job;
  assert.equal(clar.clarify!.candidates.length, 2);
  assert.ok(answerJob(env, clar.job_id, { pick: 1 }, OWNER_CLI).ok);
  const w3 = startChild(root);
  assert.equal(await w3.done, 0);
  rec = readBatch(env, batchId)!;
  assert.equal(rec.rows.find((r) => r.line === 7)!.state, "built");
  kinds = listNotices(env, { batch_id: batchId }).map((n) => n.kind).sort();
  assert.deepEqual(kinds, ["batch_accepted", "batch_finished", "batch_identified"], "exactly one notice per batch stage");
  for (const r of rec.rows) assert.ok(r.outcome && r.outcome.length > 0, `row ${r.line} has an outcome`);
  // local batch notices were delivered to the batch's notices.log once each and moved to sent/
  assert.equal(listPendingNotices(env).filter((n) => n.batch_id === batchId).length, 0);
  const nl = fs.readFileSync(path.join(env.queueDir, "batches", batchId, "notices.log"), "utf8").trim().split("\n");
  assert.equal(nl.length, 3);
  // no per-job notices for batch rows
  for (const r of rec.rows) if (r.job_id) assert.equal(listNotices(env, { job_id: r.job_id }).length, 0);
});

// ------------------------------------------------------------------ 3. release requeues held queue jobs

test("gate (CP-038): hold during the queue → job held; release (service) → queued → the worker finishes it", async (t) => {
  const root = tmp(t, "sfsh-m4gate-3-");
  const env = makeEnv(root);
  seedWork(env, { work_id: "novel-hoshifuru-toudai-2001", title: "星降る灯台", medium: "novel", title_reading: "ほしふる とうだい" });
  const service = createSfshService(env);
  const r = service.request({ origin: "cli", work: "星降る灯台", range: "全体" });
  assert.ok(r.ok);
  const id = (r.data as { job_id: string }).job_id;
  const deps = childDeps(root);
  // hold the work right after the first research stage
  const orig = deps.stageOverrides!.search_r1!;
  deps.stageOverrides!.search_r1 = async (ctx) => {
    const out = await orig(ctx);
    const w = readWork(path.join(env.worksDir, "novel-hoshifuru-toudai-2001"));
    w.publish_mode = "Restricted";
    w.history.push({ at: new Date(Date.now() + 1000).toISOString(), event: "hold", job_id: null, actor: "owner(cli)" });
    writeWork(path.join(env.worksDir, "novel-hoshifuru-toudai-2001"), w);
    return out;
  };
  deps.stageOverrides!.fact = async () => ({ outputs: [], metrics: {}, warnings: [] }); // no slow stage here
  await runWorker(env, deps, { once: true });
  assert.equal(findJob(env, id)!.job.state, "held");
  const rel = await service.release("novel-hoshifuru-toudai-2001", "gate", OWNER_CLI);
  assert.ok(rel.ok, rel.text);
  assert.deepEqual((rel.data as { requeued: string[] }).requeued, [id]);
  assert.equal(findJob(env, id)!.job.state, "queued");
  await runWorker(env, deps, { once: true });
  assert.equal(findJob(env, id)!.job.state, "built");
  assert.equal(markerCounts(root).search_r1, 1, "search_r1 was not re-run after the release");
});

// ------------------------------------------------------------------ 4. a long notice → several messages, one notice

test("gate (CP-038): a long batch notice is split into ≤2000-char Discord messages, resumes after a failure, and stays one notice", async (t) => {
  const env = makeEnv(tmp(t, "sfsh-m4gate-4-"));
  const text = Array.from({ length: 120 }, (_, i) => `  ${i + 1}行目「とても長い作品名の候補その${i + 1}」→ 候補: 作品A（小説・2001）／作品B（映画・2003）`).join("\n");
  assert.ok(text.length > 4000);
  const parts = splitForDiscord(text);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 2000, `part length ${p.length}`);
  assert.equal(parts.map((p) => p.replace(/ \(\d+\/\d+\)$/, "")).join("\n"), text, "no text lost");
  emitNotice(env, { id: "B20261123-001.batch_identified", at: "2026-11-23T09:00:00+09:00", kind: "batch_identified", job_id: null, batch_id: "B20261123-001", origin: "discord", reply_to: "chan", text, data: {} });
  const posted: string[] = [];
  let failOn = 2;
  const rest = {
    postMessage: async (_c: string, content: string) => {
      if (posted.length + 1 === failOn) {
        failOn = -1;
        throw new Error("HTTP 500");
      }
      posted.push(content);
    },
  };
  const st = createNotifierState();
  const r1 = await deliverNotices(env, rest, new Date(0), st);
  assert.equal(r1.failed, 1);
  assert.equal(listPendingNotices(env).length, 1, "still pending after a failed part");
  const r2 = await deliverNotices(env, rest, new Date(60_000), st);
  assert.equal(r2.sent, 1);
  assert.deepEqual(posted, parts, "each part posted exactly once, in order");
  assert.equal(listNotices(env).length, 1);
  assert.equal(listPendingNotices(env).length, 0);
  void saveJob;
});
