/**
 * Test kit for the Discord bot (WP-4.4; used by harness/test/discord*.test.ts and available to the M4 gate tests): temp queue env, a recording 127.0.0.1 HTTP mock, a recording fake
 * SfshService, interaction builders, a fake gateway socket and manual timers. No real network, no real Discord.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseDiscordConfig, type DiscordConfig } from "./config.ts";
import type { GatewaySocket, GatewayTimers } from "./gateway.ts";
import type { Interaction, InteractionOption, RejectLog, RejectRecord } from "./handler.ts";
import { ensureQueueDirs, type QueueEnv } from "../queue/store.ts";
import type { OpResult, SfshService } from "../queue/types.ts";

type After = { after: (f: () => void | Promise<void>) => void };

export const OWNER = { id: "100000000000000001", username: "owner" };
export const MEMBER = { id: "100000000000000002", username: "member" };
export const OTHER_MEMBER = { id: "100000000000000004", username: "member2" };
export const STRANGER = { id: "100000000000000003", username: "stranger" };
export const CHANNEL = "200000000000000001";
export const TOKEN = "test-token-not-real";

export function tmpDir(t: After, prefix = "sfsh-discord-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

export function queueEnv(t: After): QueueEnv {
  const tmp = tmpDir(t, "sfsh-discord-q-");
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

export function testConfig(over: Partial<Omit<DiscordConfig, "token">> = {}, token: string | null = TOKEN): DiscordConfig {
  return parseDiscordConfig({ owner_id: OWNER.id, allowed_user_ids: [MEMBER.id, OTHER_MEMBER.id], api_base: "http://127.0.0.1:9/api/v10", ...over }, token);
}

export function memLog(): RejectLog & { records: RejectRecord[] } {
  const records: RejectRecord[] = [];
  return { records, write: (r) => void records.push(r) };
}

// ---------------------------------------------------------------- fake service

export interface Call {
  method: string;
  args: unknown[];
}

export function fakeService(results: Partial<Record<keyof SfshService, OpResult>> = {}): SfshService & { calls: Call[] } {
  const calls: Call[] = [];
  const r = (m: keyof SfshService) => results[m] ?? { ok: true, text: `${m} ok` };
  return {
    calls,
    request: (...a) => (calls.push({ method: "request", args: a }), r("request")),
    importFile: (...a) => (calls.push({ method: "importFile", args: a }), r("importFile")),
    status: (...a) => (calls.push({ method: "status", args: a }), r("status")),
    queue: (...a) => (calls.push({ method: "queue", args: a }), r("queue")),
    cancel: (...a) => (calls.push({ method: "cancel", args: a }), r("cancel")),
    answer: (...a) => (calls.push({ method: "answer", args: a }), r("answer")),
    hold: async (...a) => (calls.push({ method: "hold", args: a }), r("hold")),
    release: async (...a) => (calls.push({ method: "release", args: a }), r("release")),
    takedown: async (...a) => (calls.push({ method: "takedown", args: a }), r("takedown")),
  };
}

// ---------------------------------------------------------------- interactions

let seq = 0;
export function interaction(user: { id: string; username: string }, sub: string, options: Record<string, string | number> = {}, extra: Partial<Interaction> = {}): Interaction {
  seq++;
  const opts: InteractionOption[] = Object.entries(options).map(([name, value]) => ({ name, type: typeof value === "number" ? 4 : 3, value }));
  return {
    id: `30000000000000${String(seq).padStart(4, "0")}`,
    application_id: "400000000000000001",
    type: 2,
    token: `interaction-token-${seq}`,
    guild_id: "500000000000000001",
    channel_id: CHANNEL,
    member: { user: { id: user.id, username: user.username, global_name: null } },
    data: { name: "sfsh", options: [{ name: sub, type: 1, options: opts }] },
    ...extra,
  };
}

// ---------------------------------------------------------------- 127.0.0.1 HTTP mock

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export type Responder = (req: Recorded) => { status?: number; headers?: Record<string, string | undefined>; body?: string | Buffer; chunks?: Buffer[] };

export async function mockServer(t: After, responder: Responder = () => ({ status: 200, body: "{}" })) {
  const requests: Recorded[] = [];
  const state = { responder };
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(parts).toString("utf8") };
      requests.push(rec);
      const r = state.responder(rec);
      res.statusCode = r.status ?? 200;
      for (const [k, v] of Object.entries(r.headers ?? { "content-type": "application/json" })) if (v !== undefined) res.setHeader(k, v);
      if (r.chunks) {
        for (const c of r.chunks) res.write(c);
        res.end();
      } else res.end(r.body ?? "");
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  t.after(() => new Promise<void>((res) => server.close(() => res())));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    base: `http://127.0.0.1:${port}`,
    setResponder(r: Responder) {
      state.responder = r;
    },
  };
}

// ---------------------------------------------------------------- fake gateway socket + manual timers

export class FakeSocket implements GatewaySocket {
  url: string;
  sent: { op: number; d: unknown }[] = [];
  closed: number[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as { op: number; d: unknown });
  }
  close(code?: number) {
    this.closed.push(code ?? 1000);
  }
  /** Server → client frame. */
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

export function fakeTimers(): GatewayTimers & { timeouts: Map<number, { fn: () => void; ms: number }>; intervals: Map<number, { fn: () => void; ms: number }>; runTimeouts(): void; tickIntervals(): void } {
  let id = 0;
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  return {
    timeouts,
    intervals,
    setTimeout: (fn, ms) => (timeouts.set(++id, { fn, ms }), id),
    clearTimeout: (h) => void timeouts.delete(h as number),
    setInterval: (fn, ms) => (intervals.set(++id, { fn, ms }), id),
    clearInterval: (h) => void intervals.delete(h as number),
    runTimeouts() {
      const due = [...timeouts.entries()];
      for (const [k, v] of due) {
        timeouts.delete(k);
        v.fn();
      }
    },
    tickIntervals() {
      for (const v of [...intervals.values()]) v.fn();
    },
  };
}
