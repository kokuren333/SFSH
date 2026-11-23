/**
 * Outbox → Discord (§4.2 notices, PLAN §4). Reads queue/outbox/pending, posts every notice with origin "discord" and a
 * reply_to to that channel, then markNoticeSent(…, "discord"). Notices of other origins are left for their owner
 * (the worker files CLI/Muse notices locally).
 *
 * Failure handling: the notice stays pending (retried on a later round).
 *  - 429: the whole round stops and nothing is sent before `retry_after` (state.notBeforeMs).
 *  - other HTTP / network errors: per-notice exponential backoff (5 s, 10 s, … max 10 min), so a permanently failing
 *    channel (403/404) does not hammer the API every few seconds.
 */
import { listPendingNotices, markNoticeSent } from "../queue/notify.ts";
import type { QueueEnv } from "../queue/store.ts";
import { DiscordHttpError, type DiscordRest } from "./rest.ts";
import { DISCORD_MAX_CONTENT } from "./handler.ts";

/**
 * One notice may exceed Discord's 2000-char limit (§4.5: a batch's clarifications are ONE notice). It is then posted
 * as consecutive messages split at line breaks (labelled (i/n)); it is still one notice and is marked sent only after
 * the last part. Progress is kept per notice so a retry resumes at the first unsent part (orchestrator, CP-038).
 */
export function splitForDiscord(text: string, max: number = DISCORD_MAX_CONTENT): string[] {
  if (text.length <= max) return [text];
  const budget = max - 12; // room for the " (i/n)" label
  const parts: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) parts.push(cur);
    cur = "";
  };
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > budget) {
      push();
      let cut = budget;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--; // keep surrogate pairs together
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (cur && cur.length + 1 + rest.length > budget) push();
    cur = cur ? `${cur}\n${rest}` : rest;
  }
  push();
  return parts.map((p, i) => `${p} (${i + 1}/${parts.length})`);
}

export interface NotifierState {
  /** Epoch ms before which no request is made (set by a 429). */
  notBeforeMs: number;
  failures: Map<string, { count: number; nextAtMs: number; lastError: string }>;
  /** Parts already posted for a split notice (resume point). */
  partsSent: Map<string, number>;
}

export function createNotifierState(): NotifierState {
  return { notBeforeMs: 0, failures: new Map(), partsSent: new Map() };
}

export interface DeliverResult {
  sent: number;
  failed: number;
  /** Discord notices not attempted this round (rate limit / backoff). */
  deferred: number;
  /** Notices of other origins (or without reply_to) left alone. */
  skipped: number;
  /** Set when a 429 was received (ms to wait). */
  retryAfterMs: number | null;
}

export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_MAX_MS = 10 * 60 * 1000;

export async function deliverNotices(env: QueueEnv, rest: Pick<DiscordRest, "postMessage">, now: Date = new Date(), state: NotifierState = createNotifierState()): Promise<DeliverResult> {
  const r: DeliverResult = { sent: 0, failed: 0, deferred: 0, skipped: 0, retryAfterMs: null };
  const t = now.getTime();
  const mine = [];
  for (const n of listPendingNotices(env)) {
    if (n.origin === "discord" && n.reply_to) mine.push(n);
    else r.skipped++;
  }
  for (let k = 0; k < mine.length; k++) {
    const n = mine[k]!;
    if (t < state.notBeforeMs) {
      r.deferred += mine.length - k;
      break;
    }
    const f = state.failures.get(n.id);
    if (f && t < f.nextAtMs) {
      r.deferred++;
      continue;
    }
    try {
      const parts = splitForDiscord(n.text);
      for (let i = state.partsSent.get(n.id) ?? 0; i < parts.length; i++) {
        await rest.postMessage(n.reply_to!, parts[i]!);
        state.partsSent.set(n.id, i + 1);
      }
    } catch (e) {
      if (e instanceof DiscordHttpError && e.status === 429) {
        r.retryAfterMs = e.retryAfterMs ?? 1000;
        state.notBeforeMs = t + r.retryAfterMs;
        r.deferred += mine.length - k;
        break;
      }
      const count = (f?.count ?? 0) + 1;
      state.failures.set(n.id, { count, nextAtMs: t + Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS), lastError: (e as Error).message });
      r.failed++;
      continue;
    }
    markNoticeSent(env, n.id, "discord", now);
    state.failures.delete(n.id);
    state.partsSent.delete(n.id);
    r.sent++;
  }
  return r;
}
