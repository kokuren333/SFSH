/**
 * M5 S6 in the worker (§5.3, U-07, CP-041): after built, the worker publishes only when the publish hook is wired —
 * and the hook is wired only when the production gate is open AND mode is "auto". Before the opening (gate closed,
 * the default) and in manual mode every job stops at built. Temp dirs only; the publish hook here is a stub.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { autoPublishHook } from "../src/commands/queue.ts";
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig } from "../src/publish/config.ts";
import { listNotices } from "../src/queue/notify.ts";
import { submitJob } from "../src/queue/request.ts";
import { findJob, type QueueEnv } from "../src/queue/store.ts";
import { runWorker, type WorkerDeps } from "../src/queue/worker.ts";
import { makeEnv, noFetcher, noPort, okOverrides, seedWork } from "./e2e/workerChild.ts";

const W1 = { work_id: "novel-hoshifuru-toudai-2001", title: "星降る灯台", medium: "novel", title_reading: "ほしふる とうだい" };

function setup(t: { after: (f: () => void) => void }, publish?: WorkerDeps["publish"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-qpub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = makeEnv(root);
  const deps: WorkerDeps = { luna: noPort("luna"), haiku: noPort("haiku"), fetcher: noFetcher, stageOverrides: okOverrides(), build: async () => ({ works: 1 }), publish };
  return { env, deps };
}

function submit(env: QueueEnv): string {
  const r = submitJob(env, { origin: "cli", work: "星降る灯台", range: "全体" }, new Date());
  assert.ok(r.ok, r.errors.join("; "));
  return r.job!.job_id;
}

test("hook wired (gate open + auto): built → published, completion notice says it was published", async (t) => {
  const calls: { jobId: string; workId: string }[] = [];
  const { env, deps } = setup(t, async (c) => (calls.push(c), { ok: true, summary: "pushed production abc", release_id: "20261123-120000000" }));
  seedWork(env, W1);
  const id = submit(env);
  const s = await runWorker(env, deps, { once: true });
  assert.deepEqual(s.processed, [{ job_id: id, state: "published" }]);
  const loc = findJob(env, id)!;
  assert.equal(loc.job.state, "published");
  assert.equal(loc.dir, "done");
  assert.deepEqual(calls, [{ jobId: id, workId: W1.work_id }]);
  const done = listNotices(env, { job_id: id }).find((n) => n.kind === "completed")!;
  assert.match(done.text, /公開しました（リリース 20261123-120000000）/);
  const log = fs.readFileSync(path.join(env.jobsDir, `${id}.log`), "utf8");
  // AMENDMENT 13: built → publish_pending (slot freed, publish lane) → published
  assert.match(log, /state built -> publish_pending/);
  assert.match(log, /state publish_pending -> published/);
});

test("hook wired but the publish fails: the job stays built (not failed) and the notice says so", async (t) => {
  const { env, deps } = setup(t, async () => ({ ok: false, summary: "blocked: push-pre verification failed", release_id: "r" }));
  seedWork(env, W1);
  const id = submit(env);
  await runWorker(env, deps, { once: true });
  assert.equal(findJob(env, id)!.job.state, "built");
  assert.match(listNotices(env, { job_id: id }).find((n) => n.kind === "completed")!.text, /公開に失敗しました（ジョブは built のまま/);
});

test("Restricted work: never published even with the hook wired", async (t) => {
  let called = 0;
  const { env, deps } = setup(t, async () => (called++, { ok: true, summary: "x", release_id: "r" }));
  seedWork(env, { ...W1, publish_mode: "Restricted" });
  const id = submit(env);
  await runWorker(env, deps, { once: true });
  assert.equal(findJob(env, id)!.job.state, "built");
  assert.equal(called, 0);
});

test("autoPublishHook: not wired while the gate is closed (default) or in manual mode → jobs stop at built", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-qpub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = makeEnv(root);
  assert.equal(autoPublishHook(env, parsePublishConfig(DEFAULT_PUBLISH_CONFIG)), undefined, "gate closed (default)");
  assert.equal(autoPublishHook(env, parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, mode: "auto", remote_url: "https://github.com/example/site.git" })), undefined, "gate closed even with remote_url and auto");
  assert.equal(autoPublishHook(env, parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, production_enabled: true, remote_url: "https://github.com/example/site.git", mode: "manual" })), undefined, "manual mode");
  // Under the test runner the real config is never consulted.
  assert.equal(autoPublishHook(env), undefined);
});
