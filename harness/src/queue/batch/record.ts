/**
 * queue/batches/<batch_id>/ store: id allocation (O_EXCL mkdir), batch.json read / atomic write (tmp + rename),
 * and a per-batch mkdir lock so importBatch (CLI / bot process) and refreshBatch (worker process) never overwrite
 * each other's batch.json. The importer holds the lock for the whole import; a lock whose owner pid is dead is taken over.
 */
import fs from "node:fs";
import path from "node:path";
import type { QueueEnv } from "../store.ts";
import { BATCH_ID_RE, type BatchRecord } from "./types.ts";
import { renameSyncRetry } from "../../util/fsRetry.ts";

export function batchesDir(env: QueueEnv): string {
  return path.join(env.queueDir, "batches");
}

export function batchDir(env: QueueEnv, batchId: string): string {
  if (!BATCH_ID_RE.test(batchId)) throw new Error(`invalid batch_id: ${batchId}`);
  return path.join(batchesDir(env), batchId);
}

export function batchJsonPath(env: QueueEnv, batchId: string): string {
  return path.join(batchDir(env, batchId), "batch.json");
}

function dayOf(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** Reserve `B<YYYYMMDD>-<NNN>` by creating queue/batches/<id>/ exclusively. */
export function allocateBatchDir(env: QueueEnv, now: Date): { batchId: string; dir: string } {
  const root = batchesDir(env);
  fs.mkdirSync(root, { recursive: true });
  const day = dayOf(now);
  const re = new RegExp(`^B${day}-(\\d{3})$`);
  let n = 1;
  for (const name of fs.readdirSync(root)) {
    const m = name.match(re);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  for (; n <= 999; n++) {
    const batchId = `B${day}-${String(n).padStart(3, "0")}`;
    const dir = path.join(root, batchId);
    try {
      fs.mkdirSync(dir); // non-recursive: EEXIST when another importer took it
      return { batchId, dir };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`batch id space exhausted for ${day}`);
}

export function readBatch(env: QueueEnv, batchId: string): BatchRecord | null {
  const file = batchJsonPath(env, batchId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as BatchRecord;
}

export function writeBatch(env: QueueEnv, rec: BatchRecord): void {
  const file = batchJsonPath(env, rec.batch_id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", "utf8");
  renameSyncRetry(tmp, file);
}

export function listBatchIds(env: QueueEnv): string[] {
  const root = batchesDir(env);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => BATCH_ID_RE.test(n) && fs.existsSync(path.join(root, n, "batch.json")))
    .sort();
}

// ---------------------------------------------------------------- lock

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const STALE_MS = 10 * 60_000;

/** Try to take queue/batches/<id>/.lock/. Returns a release function, or null after timeoutMs. */
export function acquireBatchLock(env: QueueEnv, batchId: string, timeoutMs = 15_000): (() => void) | null {
  const lock = path.join(batchDir(env, batchId), ".lock");
  const owner = path.join(lock, "owner.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", "utf8");
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // held: take over when the owner is dead or the lock is very old
    let stale = false;
    try {
      const o = JSON.parse(fs.readFileSync(owner, "utf8")) as { pid: number; at: string };
      stale = (o.pid !== process.pid && !pidAlive(o.pid)) || Date.now() - Date.parse(o.at) > STALE_MS;
    } catch {
      // owner file not written yet (or a crash right after mkdir): judge by the directory age
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > 5_000;
      } catch {
        continue; // released meanwhile
      }
    }
    if (stale) {
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    sleepMs(25);
  }
}
