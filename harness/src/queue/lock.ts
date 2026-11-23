/**
 * Single-worker lock (§4.4 "同時実行1", PLAN §3): `queue/worker.lock/` created with mkdir (atomic), holding an
 * `owner` file `<pid>:<token>`. A lock whose owner pid is dead (worker killed) is taken over; a lock whose owner
 * file is missing (killed between mkdir and write) is taken over once it is older than STALE_EMPTY_MS.
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import type { QueueEnv } from "./store.ts";

const STALE_EMPTY_MS = 10_000;

export function workerLockDir(env: QueueEnv): string {
  return path.join(env.queueDir, "worker.lock");
}

/** queue/worker.log: worker start/stop, lock take-over, recovery summary. */
export function workerLogPath(env: QueueEnv): string {
  return path.join(env.queueDir, "worker.log");
}

export function appendWorkerLog(env: QueueEnv, msg: string, now: Date = new Date()): void {
  fs.mkdirSync(env.queueDir, { recursive: true });
  fs.appendFileSync(workerLogPath(env), `${isoLocal(now)} pid=${process.pid} ${msg.replace(/\r?\n/g, " / ")}\n`, "utf8");
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockOwner {
  pid: number;
  token: string;
}

export function readLockOwner(env: QueueEnv): LockOwner | null {
  try {
    const raw = fs.readFileSync(path.join(workerLockDir(env), "owner"), "utf8").trim();
    const [pid, token] = raw.split(":");
    return { pid: Number(pid), token: token ?? "" };
  } catch {
    return null;
  }
}

export interface WorkerLock {
  /** Owner pid of the stale lock that was taken over (null when the lock was free). */
  tookOverFrom: number | null;
  release: () => void;
}

export class WorkerBusyError extends Error {
  pid: number;
  constructor(pid: number) {
    super(`another worker is running (pid ${pid}); only one worker may run at a time`);
    this.name = "WorkerBusyError";
    this.pid = pid;
  }
}

/** Take the lock or throw WorkerBusyError. */
export function acquireWorkerLock(env: QueueEnv, now: () => Date = () => new Date()): WorkerLock {
  const dir = workerLockDir(env);
  fs.mkdirSync(env.queueDir, { recursive: true });
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let tookOverFrom: number | null = null;
  for (let tries = 0; tries < 50; tries++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "owner"), `${process.pid}:${token}`, "utf8");
      if (tookOverFrom !== null) appendWorkerLog(env, `took over stale worker lock (owner pid ${tookOverFrom} is not running)`, now());
      return {
        tookOverFrom,
        release: () => {
          const o = readLockOwner(env);
          if (o && o.pid === process.pid && o.token === token) fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = readLockOwner(env);
      if (owner) {
        if (owner.pid === process.pid || !pidAlive(owner.pid)) {
          // our own pid can only be a leftover of an earlier run in this process that did not release; dead pid: crashed worker
          tookOverFrom = owner.pid;
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
        throw new WorkerBusyError(owner.pid);
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue; // removed meanwhile
      }
      if (age > STALE_EMPTY_MS) {
        tookOverFrom = 0;
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      // being created right now by another process: wait a little
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  const o = readLockOwner(env);
  throw new WorkerBusyError(o?.pid ?? 0);
}
