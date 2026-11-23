/**
 * AMENDMENT 14: global cap on model calls running at the same time (harness/config/parallel.json global_model_calls).
 *
 * Every model CLI process (Haiku = claude -p, Luna = codex exec) is started only while holding a slot. The cap is
 * shared by every job of the worker (AMENDMENT 13 job slots run in one process) AND by every other sfsh process on the
 * PC (`job resume`, `regen`, a second terminal): slots are directories `logs/model-slots/slot-<n>/` created with mkdir
 * (atomic), each holding an `owner` file `<pid>:<token>`.
 *
 *  - In one process a FIFO queue hands slots out in request order (no busy loop per waiting call).
 *  - Across processes a waiting process re-tries every 60–150 ms; a slot whose owner pid is dead (process killed) is
 *    taken over, a slot without an owner file older than STALE_EMPTY_MS likewise.
 *  - The caller's timeout starts when its process starts (waiting for a slot is not counted against it).
 *  - Slots held by this process are removed on exit (also on SIGINT / SIGTERM through process 'exit').
 *
 * When the cap is lowered while slots are held, the extra slots drain naturally (no new process above the new cap).
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";
import { loadParallelConfig } from "../util/parallel.ts";

const STALE_EMPTY_MS = 10_000;

export function modelSlotsDir(): string {
  return process.env.SFSH_MODEL_SLOTS_DIR || path.join(paths.root, "logs", "model-slots");
}

export interface SlotStats {
  /** calls that got a slot */
  acquired: number;
  /** calls that had to wait for a slot */
  waited: number;
  /** total wait (ms) */
  waitMs: number;
  /** most slots held by this process at once */
  peakHeld: number;
  /** stale slots of dead processes taken over */
  tookOver: number;
}

const stats: SlotStats = { acquired: 0, waited: 0, waitMs: 0, peakHeld: 0, tookOver: 0 };
export function slotStats(): SlotStats {
  return { ...stats };
}

const token = `${process.pid}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const held = new Set<string>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const d of held) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove the slot dir when its owner is gone. True when it was removed. */
function reapIfStale(dir: string): boolean {
  let owner: string | null = null;
  try {
    owner = fs.readFileSync(path.join(dir, "owner"), "utf8").trim();
  } catch {
    owner = null;
  }
  let stale = false;
  if (owner) {
    const pid = Number(owner.split(":")[0]);
    stale = pid !== process.pid && !pidAlive(pid);
  } else {
    try {
      stale = Date.now() - fs.statSync(dir).mtimeMs > STALE_EMPTY_MS;
    } catch {
      return false; // already gone
    }
  }
  if (!stale) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    stats.tookOver++;
    return true;
  } catch {
    return false;
  }
}

/** Try once to take a free slot dir among slot-0..slot-(cap-1). */
function tryTake(root: string, cap: number): string | null {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < cap; i++) {
    const dir = path.join(root, `slot-${i}`);
    if (held.has(dir)) continue;
    try {
      fs.mkdirSync(dir);
    } catch {
      if (reapIfStale(dir)) {
        try {
          fs.mkdirSync(dir);
        } catch {
          continue;
        }
      } else continue;
    }
    try {
      fs.writeFileSync(path.join(dir, "owner"), token, "utf8");
    } catch {
      /* owner missing → treated as stale only after STALE_EMPTY_MS */
    }
    return dir;
  }
  return null;
}

const waiters: (() => void)[] = [];
let pumping = false;

/**
 * Wait for a global model-call slot. Returns the release function (idempotent).
 * `capOverride` / `rootOverride` are for tests.
 */
export async function acquireModelSlot(opts: { cap?: number; root?: string } = {}): Promise<() => void> {
  hookExit();
  const root = opts.root ?? modelSlotsDir();
  const t0 = Date.now();
  let waited = false;
  // FIFO inside the process: the oldest waiter tries first
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
    if (waiters.length === 1) resolve();
  });
  let dir: string | null = null;
  try {
    for (;;) {
      const cap = opts.cap ?? loadParallelConfig().global_model_calls;
      dir = held.size < cap ? tryTake(root, cap) : null;
      if (dir) break;
      waited = true;
      await new Promise((r) => setTimeout(r, 60 + Math.floor(Math.random() * 90)));
    }
  } finally {
    waiters.shift();
    const next = waiters[0];
    if (next) next();
  }
  held.add(dir);
  stats.acquired++;
  if (waited) {
    stats.waited++;
    stats.waitMs += Date.now() - t0;
  }
  stats.peakHeld = Math.max(stats.peakHeld, held.size);
  let released = false;
  const d = dir;
  return () => {
    if (released) return;
    released = true;
    held.delete(d);
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort; a stale slot of this pid is reaped only after exit */
    }
  };
}

/** Run `fn` while holding a global model-call slot. */
export async function withModelSlot<T>(fn: () => Promise<T>, opts: { cap?: number; root?: string } = {}): Promise<T> {
  const release = await acquireModelSlot(opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Slots currently held by any process (status / measurement). */
export function heldSlots(root: string = modelSlotsDir()): { slot: string; owner: string | null }[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => n.startsWith("slot-"))
    .map((n) => {
      let owner: string | null = null;
      try {
        owner = fs.readFileSync(path.join(root, n, "owner"), "utf8").trim();
      } catch {
        owner = null;
      }
      return { slot: n, owner };
    });
}
