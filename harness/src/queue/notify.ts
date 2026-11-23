/**
 * Notification outbox (§4.2 / §4.5). The worker (and the CLI) write notices to queue/outbox/pending/<id>.json;
 * a sender (the Discord bot, or nobody for local origins) moves them to queue/outbox/sent/ after delivery.
 * Ids are deterministic and written with O_EXCL → at most one notice per (job|batch, stage) even across restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import type { QueueEnv } from "./store.ts";
import type { Notice } from "./types.ts";

function dirs(env: QueueEnv) {
  return { pending: path.join(env.queueDir, "outbox", "pending"), sent: path.join(env.queueDir, "outbox", "sent") };
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`notice id must be [A-Za-z0-9._-]: ${id}`);
  return id;
}

/** Write a notice once. Returns false when a notice with the same id already exists (pending or sent). */
export function emitNotice(env: QueueEnv, notice: Notice): boolean {
  const d = dirs(env);
  fs.mkdirSync(d.pending, { recursive: true });
  fs.mkdirSync(d.sent, { recursive: true });
  const name = `${safeId(notice.id)}.json`;
  if (fs.existsSync(path.join(d.sent, name))) return false;
  try {
    fs.writeFileSync(path.join(d.pending, name), JSON.stringify(notice, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function readDir(dir: string): Notice[] {
  if (!fs.existsSync(dir)) return [];
  const out: Notice[] = [];
  for (const n of fs.readdirSync(dir).sort()) {
    if (!n.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as Notice);
    } catch {
      /* half-written: skipped until complete */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

export function listPendingNotices(env: QueueEnv): Notice[] {
  return readDir(dirs(env).pending);
}

export function listNotices(env: QueueEnv, filter: { job_id?: string; batch_id?: string } = {}): Notice[] {
  const d = dirs(env);
  return [...readDir(d.pending), ...readDir(d.sent)]
    .filter((n) => (!filter.job_id || n.job_id === filter.job_id) && (!filter.batch_id || n.batch_id === filter.batch_id))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Move a delivered notice to sent/ (stamping sent_at / sent_via). */
export function markNoticeSent(env: QueueEnv, id: string, via: string, now: Date = new Date()): void {
  const d = dirs(env);
  const src = path.join(d.pending, `${safeId(id)}.json`);
  if (!fs.existsSync(src)) return;
  const n = JSON.parse(fs.readFileSync(src, "utf8")) as Notice;
  n.sent_at = isoLocal(now);
  n.sent_via = via;
  const tmp = path.join(d.pending, `${id}.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(n, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, src);
  fs.renameSync(src, path.join(d.sent, `${id}.json`));
}
