/**
 * Gate 7.2 M4 "ワーカー強制終了→次回起動で続きから再開": the worker runs in a child process
 * (harness/test/e2e/workerChild.ts), is killed with SIGKILL inside a mid-pipeline stage, and a new worker process
 * resumes the job: stages done before the kill are not re-run, the killed stage runs again (the kill counts as one
 * attempt), the stale worker lock is taken over, and logs/jobs/<id>.log records the resume.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readState, STAGES } from "../src/job/runner.ts";
import { submitJob } from "../src/queue/request.ts";
import { findJob } from "../src/queue/store.ts";
import { makeEnv, markerCounts, seedWork, SLOW_STAGE } from "./e2e/workerChild.ts";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e", "workerChild.ts");

function spawnChild(root: string): { child: ChildProcess; exited: Promise<{ code: number | null; signal: string | null; out: string }> } {
  const child = spawn(process.execPath, [CHILD, root], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout!.on("data", (b) => (out += b));
  child.stderr!.on("data", (b) => (out += b));
  const exited = new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, out })));
  return { child, exited };
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("worker SIGKILL mid-pipeline → a new worker resumes from the killed stage; earlier stages are not re-run; stale lock taken over", { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-qcrash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = makeEnv(root);
  seedWork(env, { work_id: "novel-hoshifuru-toudai-2001", title: "星降る灯台", medium: "novel" });
  const sub = submitJob(env, { origin: "cli", work: "星降る灯台", range: "全体" });
  assert.ok(sub.ok);
  const id = sub.job!.job_id;

  // 1st worker: killed while SLOW_STAGE runs
  const first = spawnChild(root);
  t.after(() => first.child.kill("SIGKILL"));
  await waitFor(() => fs.existsSync(path.join(root, "markers", `${SLOW_STAGE}.txt`)), 10_000, `${SLOW_STAGE} to start`);
  const mid = readState(env.jobsDir, id);
  assert.equal(mid.stages[SLOW_STAGE].status, "running");
  assert.equal(findJob(env, id)!.dir, "running");
  assert.equal(findJob(env, id)!.job.state, "structuring");
  first.child.kill("SIGKILL");
  const r1 = await first.exited;
  assert.ok(r1.code !== 0 || r1.signal, "first worker was killed");
  const lockOwner = fs.readFileSync(path.join(env.queueDir, "worker.lock", "owner"), "utf8");
  assert.equal(Number(lockOwner.split(":")[0]), first.child.pid, "the killed worker left its lock behind");
  const before = markerCounts(root);

  // 2nd worker: resumes
  const second = spawnChild(root);
  t.after(() => second.child.kill("SIGKILL"));
  const r2 = await second.exited;
  assert.equal(r2.code, 0, r2.out);

  const loc = findJob(env, id)!;
  assert.equal(loc.job.state, "built", loc.job.error ?? "");
  assert.equal(loc.dir, "done");
  const after = markerCounts(root);
  const k = STAGES.indexOf(SLOW_STAGE);
  for (const s of STAGES.slice(1, k)) {
    assert.equal(before[s], 1, `${s} ran once before the kill`);
    assert.equal(after[s], 1, `${s} was not re-run after the restart`);
  }
  assert.equal(after[SLOW_STAGE], 2, "the killed stage ran again");
  for (const s of STAGES.slice(k + 1)) assert.equal(after[s], 1, `${s} ran once (after the restart)`);
  const st = readState(env.jobsDir, id);
  assert.equal(st.stages[SLOW_STAGE].attempts, 2, "the kill counted as one attempt");
  assert.ok(STAGES.every((s) => st.stages[s].status === "done"));

  const summary = JSON.parse(r2.out.trim().split("\n").pop()!);
  assert.equal(summary.tookOverFrom, first.child.pid);
  assert.match(fs.readFileSync(path.join(env.queueDir, "worker.log"), "utf8"), new RegExp(`took over stale worker lock \\(owner pid ${first.child.pid}`));
  const log = fs.readFileSync(path.join(env.jobsDir, `${id}.log`), "utf8");
  assert.match(log, new RegExp(`worker recovery: stage ${SLOW_STAGE}@attempt1 was running \\(pid ${first.child.pid}\\) → pending, attempt count kept`));
  assert.match(log, /worker recovery: was structuring when the previous worker stopped; resumes from the first unfinished stage/);
  assert.match(log, new RegExp(`resumes at stage ${SLOW_STAGE}`));
  assert.match(log, new RegExp(`stage ${SLOW_STAGE} start \\(attempt 2/3\\)`));
  assert.ok(!fs.existsSync(path.join(env.queueDir, "worker.lock")), "lock released at exit");
});
