/**
 * AMENDMENT 13: parallel job slots. Temp dirs only; stages are timed stubs, the publish hook is a stub that records
 * its own start/end so overlap can be measured.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { answerJob } from "../src/queue/ops.ts";
import { submitJob } from "../src/queue/request.ts";
import { findJob, listJobs, type QueueEnv } from "../src/queue/store.ts";
import { runWorker, type WorkerDeps } from "../src/queue/worker.ts";
import { makeEnv, noFetcher, noPort, okOverrides, okStage, seedWork } from "./e2e/workerChild.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORKS = ["a", "b", "c", "d"].map((k) => ({ work_id: `novel-par${k}-2001`, title: `並行作品${k.toUpperCase()}`, medium: "novel" }));

function setup(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-qpar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = makeEnv(root);
  for (const w of WORKS) seedWork(env, w);
  return env;
}
function submit(env: QueueEnv, work: string, range = "全体"): string {
  const r = submitJob(env, { origin: "cli", work, range }, new Date());
  assert.ok(r.ok, r.errors.join("; "));
  return r.job!.job_id;
}

test("3 slots: three jobs run at the same time; publishes never overlap and follow build order; queue files stay single", async (t) => {
  const env = setup(t);
  const ids = WORKS.slice(0, 3).map((w) => submit(env, w.title));
  const live = new Set<string>();
  let peakStage = 0;
  const overrides = okOverrides();
  overrides.fact = async (ctx) => {
    live.add(ctx.jobId);
    peakStage = Math.max(peakStage, live.size);
    // different lengths → builds finish in the order c, b, a
    await sleep(ctx.jobId === ids[0] ? 600 : ctx.jobId === ids[1] ? 400 : 200);
    live.delete(ctx.jobId);
    return okStage();
  };
  const pubs: { jobId: string; start: number; end: number }[] = [];
  const waitOrder: string[] = [];
  let inPublish = 0;
  let overlap = 0;
  const deps: WorkerDeps = {
    luna: noPort("luna"),
    haiku: noPort("haiku"),
    fetcher: noFetcher,
    stageOverrides: overrides,
    build: async () => (await sleep(20), { works: 3 }),
    afterTransition: (j) => void (j.state === "publish_pending" && !j.publish_wait?.started_at && !waitOrder.includes(j.job_id) && waitOrder.push(j.job_id)),
    publish: async ({ jobId }) => {
      inPublish++;
      if (inPublish > 1) overlap++;
      const start = Date.now();
      await sleep(150);
      pubs.push({ jobId, start, end: Date.now() });
      inPublish--;
      return { ok: true, summary: "pushed test", release_id: `r-${jobId}` };
    },
  };
  const s = await runWorker(env, deps, { once: true, concurrency: 3, pollMs: 50 });
  assert.equal(s.peakSlots, 3);
  assert.equal(peakStage, 3, "all three were inside the fact stage at once");
  assert.equal(overlap, 0, "publishes never overlapped");
  assert.equal(waitOrder.length, 3);
  assert.deepEqual(pubs.map((p) => p.jobId), waitOrder, "publish order = order the builds finished (publish_pending)");
  for (let i = 1; i < pubs.length; i++) assert.ok(pubs[i]!.start >= pubs[i - 1]!.end);
  for (const id of ids) {
    const loc = findJob(env, id)!;
    assert.equal(loc.job.state, "published");
    assert.equal(loc.job.publish_wait, null);
  }
  assert.deepEqual(s.processed.map((p) => p.state), ["published", "published", "published"]);
  // every job file exists exactly once, no tmp leftovers, no lock left
  const all = listJobs(env);
  assert.equal(all.length, 3);
  for (const d of fs.readdirSync(env.queueDir)) if (fs.statSync(path.join(env.queueDir, d)).isDirectory()) assert.ok(!fs.readdirSync(path.join(env.queueDir, d)).some((f) => f.endsWith(".tmp")));
  assert.ok(!fs.existsSync(path.join(env.queueDir, "state.lock")));
  assert.ok(!fs.existsSync(path.join(env.queueDir, "worker.lock")));
});

test("a clarifying job does not hold a slot; its answer later runs beside the others", async (t) => {
  const env = setup(t);
  const bad = submit(env, WORKS[3]!.title, "第三期の後半あたり"); // unparsable range → clarifying, no identify
  const a = submit(env, WORKS[0]!.title);
  const b = submit(env, WORKS[1]!.title);
  const overrides = okOverrides();
  let answered = false;
  overrides.fact = async (ctx) => {
    if (!answered && ctx.jobId === a) {
      // while A runs, the requester answers the clarifying job (as the CLI / Discord runner would)
      answered = true;
      const r = answerJob(env, bad, { range: "全体" }, { id: "local", name: "owner", origin: "cli", is_owner: true });
      assert.ok(r.ok, r.text);
    }
    await sleep(200);
    return okStage();
  };
  const deps: WorkerDeps = { luna: noPort("luna"), haiku: noPort("haiku"), fetcher: noFetcher, stageOverrides: overrides, build: async () => ({ works: 1 }) };
  const s = await runWorker(env, deps, { once: true, concurrency: 2, pollMs: 50 });
  assert.equal(s.peakSlots, 2);
  for (const id of [a, b, bad]) assert.equal(findJob(env, id)!.job.state, "built", id);
  // the clarifying job never entered running/ before its answer
  const log = fs.readFileSync(path.join(env.jobsDir, `${bad}.log`), "utf8");
  assert.ok(log.indexOf("-> clarifying") < log.indexOf("-> queued"));
});

test("cancel of a waiting publish_pending job: the lane skips it", async (t) => {
  const env = setup(t);
  const a = submit(env, WORKS[0]!.title);
  const b = submit(env, WORKS[1]!.title);
  const overrides = okOverrides();
  overrides.fact = async (ctx) => (await sleep(ctx.jobId === a ? 50 : 100), okStage());
  const published: string[] = [];
  const deps: WorkerDeps = {
    luna: noPort("luna"),
    haiku: noPort("haiku"),
    fetcher: noFetcher,
    stageOverrides: overrides,
    build: async () => ({ works: 2 }),
    publish: async ({ jobId }) => {
      // while A publishes, B is built and waiting: cancel it (A's own cancel is refused: publishing)
      if (jobId === a) {
        while (findJob(env, b)?.job.state !== "publish_pending") await sleep(10);
        const { cancelJob } = await import("../src/queue/ops.ts");
        const owner = { id: "local", name: "owner", origin: "cli" as const, is_owner: true };
        assert.equal(cancelJob(env, a, owner).ok, false);
        assert.equal(cancelJob(env, b, owner).ok, true);
      }
      published.push(jobId);
      return { ok: true, summary: "ok", release_id: "r" };
    },
  };
  await runWorker(env, deps, { once: true, concurrency: 2, pollMs: 30 });
  assert.deepEqual(published, [a]);
  assert.equal(findJob(env, a)!.job.state, "published");
  assert.equal(findJob(env, b)!.job.state, "cancelled");
});
