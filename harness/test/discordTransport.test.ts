/**
 * WP-4.4 Discord transport: REST client, outbox notifier, gateway client and the bot runner — against a 127.0.0.1
 * HTTP mock and a fake gateway socket. Nothing connects to Discord.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startBot } from "../src/discord/bot.ts";
import { createGateway, OP } from "../src/discord/gateway.ts";
import { createNotifierState, deliverNotices } from "../src/discord/notifier.ts";
import { createRest, DiscordHttpError, parseRetryAfter } from "../src/discord/rest.ts";
import { CHANNEL, FakeSocket, fakeService, fakeTimers, interaction, MEMBER, memLog, mockServer, queueEnv, STRANGER, testConfig, TOKEN } from "../src/discord/testkit.ts";
import { emitNotice, listPendingNotices } from "../src/queue/notify.ts";
import type { QueueEnv } from "../src/queue/store.ts";
import type { Notice, Origin } from "../src/queue/types.ts";

function notice(env: QueueEnv, id: string, origin: Origin, reply_to: string | null, text = `通知 ${id}`, at = "2026-11-23T10:00:00+09:00"): void {
  const n: Notice = { id, at, kind: "received", job_id: id.split(".")[0]!, batch_id: null, origin, reply_to, text, data: {} };
  assert.ok(emitNotice(env, n));
}
const sentIds = (env: QueueEnv) => fs.readdirSync(path.join(env.queueDir, "outbox", "sent")).sort();
const pendingIds = (env: QueueEnv) => listPendingNotices(env).map((n) => n.id);

// ---------------------------------------------------------------- REST

test("REST client: Bot auth, JSON, no mentions, routes, 429 retry_after parsed", async (t) => {
  const srv = await mockServer(t, (req) => (req.url.includes("/channels/999/") ? { status: 429, body: JSON.stringify({ message: "You are being rate limited.", retry_after: 1.25, global: false }) } : { status: 200, body: '{"id":"1"}' }));
  const rest = createRest({ apiBase: `${srv.base}/api/v10/`, token: TOKEN });
  assert.deepEqual(await rest.postMessage(CHANNEL, "こんにちは @everyone"), { id: "1" });
  const r0 = srv.requests[0]!;
  assert.equal(r0.method, "POST");
  assert.equal(r0.url, `/api/v10/channels/${CHANNEL}/messages`);
  assert.equal(r0.headers.authorization, `Bot ${TOKEN}`);
  assert.equal(r0.headers["content-type"], "application/json");
  assert.match(String(r0.headers["user-agent"]), /^DiscordBot /);
  assert.deepEqual(JSON.parse(r0.body), { content: "こんにちは @everyone", allowed_mentions: { parse: [] } });

  await rest.interactionCallback("300", "tok/en", { content: "ok", ephemeral: true });
  const r1 = srv.requests[1]!;
  assert.equal(r1.url, "/api/v10/interactions/300/tok%2Fen/callback");
  assert.equal(r1.headers.authorization, undefined, "interaction callbacks are authorised by the interaction token");
  assert.deepEqual(JSON.parse(r1.body), { type: 4, data: { content: "ok", flags: 64, allowed_mentions: { parse: [] } } });
  await rest.interactionCallback("301", "t", { content: "", ephemeral: false }, true);
  assert.deepEqual(JSON.parse(srv.requests[2]!.body), { type: 5, data: { flags: 0 } });
  await rest.editOriginal("400", "t", "x".repeat(3000));
  assert.equal(srv.requests[3]!.method, "PATCH");
  assert.equal(srv.requests[3]!.url, "/api/v10/webhooks/400/t/messages/@original");
  assert.ok(JSON.parse(srv.requests[3]!.body).content.length <= 2000);
  await rest.putCommands("400", null, []);
  assert.equal(srv.requests[4]!.url, "/api/v10/applications/400/commands");
  assert.equal(srv.requests[4]!.method, "PUT");

  await assert.rejects(rest.postMessage("999", "x"), (e: unknown) => e instanceof DiscordHttpError && e.status === 429 && e.retryAfterMs === 1250);
  assert.equal(parseRetryAfter("not json", "3"), 3000);
  assert.equal(parseRetryAfter("{}", null), null);
  await assert.rejects(createRest({ apiBase: srv.base, token: null }).postMessage("1", "x"), /token/);
});

// ---------------------------------------------------------------- (vi) notifier

test("(vi) notifier posts only discord-origin notices with reply_to, marks them sent", async (t) => {
  const env = queueEnv(t);
  notice(env, "20261123-0001.received", "discord", CHANNEL, "受付: 20261123-0001");
  notice(env, "20261123-0002.received", "cli", null);
  notice(env, "20261123-0003.received", "discord", null); // no reply_to → not ours
  notice(env, "20261123-0004.completed", "discord", "200000000000000009", "完了 ".repeat(600)); // near the limit (longer notices are split: m4Gate.test.ts, CP-038)
  notice(env, "20261123-0005.received", "muse", null);
  const srv = await mockServer(t);
  const rest = createRest({ apiBase: srv.base, token: TOKEN });
  const r = await deliverNotices(env, rest, new Date("2026-11-23T10:00:05+09:00"));
  assert.deepEqual(r, { sent: 2, failed: 0, deferred: 0, skipped: 3, retryAfterMs: null });
  assert.deepEqual(
    srv.requests.map((q) => q.url),
    [`/channels/${CHANNEL}/messages`, "/channels/200000000000000009/messages"],
  );
  assert.equal(JSON.parse(srv.requests[0]!.body).content, "受付: 20261123-0001");
  assert.ok(JSON.parse(srv.requests[1]!.body).content.length <= 2000);
  assert.deepEqual(sentIds(env), ["20261123-0001.received.json", "20261123-0004.completed.json"]);
  const sent = JSON.parse(fs.readFileSync(path.join(env.queueDir, "outbox", "sent", "20261123-0001.received.json"), "utf8")) as Notice;
  assert.equal(sent.sent_via, "discord");
  assert.ok(sent.sent_at);
  assert.deepEqual(pendingIds(env), ["20261123-0002.received", "20261123-0003.received", "20261123-0005.received"]);
  // second round: nothing more to post
  const r2 = await deliverNotices(env, rest, new Date("2026-11-23T10:00:10+09:00"));
  assert.equal(r2.sent, 0);
  assert.equal(srv.requests.length, 2);
});

test("(vi) notifier leaves a notice pending on HTTP 500 (backoff, retried later) and honours 429 retry_after", async (t) => {
  const env = queueEnv(t);
  notice(env, "20261123-0001.received", "discord", CHANNEL, "a", "2026-11-23T10:00:00+09:00");
  notice(env, "20261123-0002.received", "discord", CHANNEL, "b", "2026-11-23T10:00:01+09:00");
  let mode: "500" | "429" | "ok" = "500";
  const srv = await mockServer(t, () => (mode === "500" ? { status: 500, body: "oops" } : mode === "429" ? { status: 429, body: JSON.stringify({ retry_after: 1.5 }) } : { status: 200, body: "{}" }));
  const rest = createRest({ apiBase: srv.base, token: TOKEN });
  const st = createNotifierState();
  const t0 = Date.parse("2026-11-23T10:00:10+09:00");
  const at = (ms: number) => new Date(t0 + ms);

  const r1 = await deliverNotices(env, rest, at(0), st);
  assert.equal(r1.failed, 2);
  assert.equal(r1.sent, 0);
  assert.equal(pendingIds(env).length, 2, "still pending after 500");
  assert.equal(srv.requests.length, 2);
  // inside the backoff window: no request
  const r2 = await deliverNotices(env, rest, at(1000), st);
  assert.equal(r2.deferred, 2);
  assert.equal(srv.requests.length, 2);

  // after the backoff: rate limited → stop the round, nothing marked
  mode = "429";
  const r3 = await deliverNotices(env, rest, at(6000), st);
  assert.equal(r3.retryAfterMs, 1500);
  assert.equal(r3.sent, 0);
  assert.equal(r3.deferred, 2);
  assert.equal(srv.requests.length, 3, "the round stops at the first 429");
  assert.equal(pendingIds(env).length, 2);
  // before retry_after has elapsed: no request at all
  mode = "ok";
  const r4 = await deliverNotices(env, rest, at(7000), st);
  assert.equal(r4.deferred, 2);
  assert.equal(srv.requests.length, 3);
  // after retry_after: both delivered, in order
  const r5 = await deliverNotices(env, rest, at(7600), st);
  assert.equal(r5.sent, 2);
  assert.deepEqual(srv.requests.slice(3).map((q) => JSON.parse(q.body).content), ["a", "b"]);
  assert.deepEqual(pendingIds(env), []);
  assert.equal(st.failures.size, 0);
});

// ---------------------------------------------------------------- (vii) gateway

test("(vii) gateway: HELLO → IDENTIFY + heartbeat with sequence, ACK, server heartbeat request, op 7 / op 9 / missed ACK / close → reconnect", () => {
  const sockets: FakeSocket[] = [];
  const timers = fakeTimers();
  const got: unknown[] = [];
  const gw = createGateway({ url: "wss://gateway.test/?v=10", token: TOKEN, socketFactory: (u) => (sockets.push(new FakeSocket(u)), sockets.at(-1)!), timers, random: () => 0.5, onInteraction: (d) => void got.push(d) });
  gw.start();
  assert.equal(sockets.length, 1);
  const s1 = sockets[0]!;
  assert.equal(s1.url, "wss://gateway.test/?v=10");
  s1.emit({ op: OP.HELLO, d: { heartbeat_interval: 40000 }, s: null, t: null });
  assert.equal(s1.sent[0]!.op, OP.IDENTIFY);
  const idf = s1.sent[0]!.d as { token: string; intents: number; properties: Record<string, string> };
  assert.equal(idf.token, TOKEN);
  assert.equal(idf.intents, 0);
  assert.equal([...timers.timeouts.values()][0]!.ms, 20000, "first beat after interval × jitter");
  timers.runTimeouts();
  assert.deepEqual(s1.sent[1], { op: OP.HEARTBEAT, d: null });
  assert.equal([...timers.intervals.values()][0]!.ms, 40000);
  s1.emit({ op: OP.HEARTBEAT_ACK });
  s1.emit({ op: OP.DISPATCH, t: "READY", s: 1, d: { session_id: "sess", user: { username: "bot" } } });
  s1.emit({ op: OP.DISPATCH, t: "GUILD_CREATE", s: 2, d: {} });
  timers.tickIntervals();
  assert.deepEqual(s1.sent[2], { op: OP.HEARTBEAT, d: 2 }, "heartbeat carries the last sequence");
  assert.equal(gw.sequence, 2);
  s1.emit({ op: OP.HEARTBEAT, d: null }); // server asks for a beat
  assert.deepEqual(s1.sent[3], { op: OP.HEARTBEAT, d: 2 });
  s1.onmessage!({ data: "not json" }); // ignored

  // op 7 RECONNECT → socket closed, new connection after the delay, fresh IDENTIFY
  s1.emit({ op: OP.RECONNECT, d: null });
  assert.deepEqual(s1.closed, [4000]);
  assert.equal(s1.onmessage, null, "old socket detached");
  assert.equal(timers.intervals.size, 0, "heartbeat stopped");
  assert.equal(sockets.length, 1);
  timers.runTimeouts();
  assert.equal(sockets.length, 2);
  const s2 = sockets[1]!;
  s2.emit({ op: OP.HELLO, d: { heartbeat_interval: 1000 } });
  assert.equal(s2.sent[0]!.op, OP.IDENTIFY);
  assert.equal(gw.connects, 2);

  // missed ACK → zombie connection → reconnect
  timers.runTimeouts(); // first beat (acked = false now)
  assert.deepEqual(s2.sent[1], { op: OP.HEARTBEAT, d: null });
  timers.tickIntervals(); // no ACK since → reconnect
  assert.deepEqual(s2.closed, [4000]);
  timers.runTimeouts();
  assert.equal(sockets.length, 3);

  // op 9 INVALID_SESSION → reconnect after 1–5 s
  const s3 = sockets[2]!;
  s3.emit({ op: OP.HELLO, d: { heartbeat_interval: 1000 } });
  s3.emit({ op: OP.INVALID_SESSION, d: false });
  const delays = [...timers.timeouts.values()].map((x) => x.ms);
  assert.ok(delays.some((ms) => ms >= 1000 && ms <= 5000), String(delays));
  timers.runTimeouts();
  assert.equal(sockets.length, 4);

  // unexpected close → reconnect; fatal close (4004 bad token) → stop
  sockets[3]!.onclose!({ code: 1006 });
  timers.runTimeouts();
  assert.equal(sockets.length, 5);
  let fatal = 0;
  const gw2 = createGateway({ url: "wss://x", token: "t", socketFactory: (u) => (sockets.push(new FakeSocket(u)), sockets.at(-1)!), timers, onInteraction: () => {}, onFatal: () => void fatal++ });
  gw2.start();
  sockets.at(-1)!.onclose!({ code: 4004, reason: "Authentication failed." });
  timers.runTimeouts();
  assert.equal(fatal, 1);
  assert.equal(gw2.connects, 1);

  // stop() closes with 1000 and does not reconnect
  gw.stop();
  assert.deepEqual(sockets[4]!.closed, [1000]);
  timers.runTimeouts();
  assert.equal(gw.connects, 5);
  assert.equal(got.length, 0);
});

test("(vii) bot: INTERACTION_CREATE over the fake gateway → handler → callback POST to the mock REST; notices delivered by the timer", async (t) => {
  const env = queueEnv(t);
  const srv = await mockServer(t, () => ({ status: 204, body: "" }));
  const cfg = testConfig({ api_base: `${srv.base}/api/v10`, production_enabled: true });
  const svc = fakeService({ request: { ok: true, text: "受付: 20261123-0001「鬼滅の刃」範囲 全体" } });
  const log = memLog();
  const timers = fakeTimers();
  const sockets: FakeSocket[] = [];
  const bot = startBot({ cfg, service: svc, queueEnv: env, socketFactory: (u) => (sockets.push(new FakeSocket(u)), sockets.at(-1)!), timers, random: () => 0, rejectLog: log, log: () => {}, noticeIntervalMs: 3000 });
  t.after(() => bot.stop());
  const s = sockets[0]!;
  assert.equal(s.url, cfg.gateway_url);
  s.emit({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  assert.equal(s.sent[0]!.op, OP.IDENTIFY);
  s.emit({ op: OP.DISPATCH, t: "READY", s: 1, d: { session_id: "x", user: { username: "sfsh" } } });

  const ok = interaction(MEMBER, "request", { work: "鬼滅の刃", range: "全体" });
  s.emit({ op: OP.DISPATCH, t: "INTERACTION_CREATE", s: 2, d: ok });
  const bad = interaction(STRANGER, "request", { work: "x", range: "全体" });
  s.emit({ op: OP.DISPATCH, t: "INTERACTION_CREATE", s: 3, d: bad });
  await new Promise((r) => setImmediate(r));
  await bot.idle();

  assert.equal(svc.calls.length, 1, "only the allowed user reached the service");
  assert.equal(log.records.length, 1);
  assert.equal(log.records[0]!.reason, "not_allowed");
  const cb = srv.requests.filter((q) => q.url.includes("/interactions/"));
  assert.equal(cb.length, 2);
  const okCb = cb.find((q) => q.url === `/api/v10/interactions/${ok.id}/${ok.token}/callback`)!;
  assert.deepEqual(JSON.parse(okCb.body), { type: 4, data: { content: "受付: 20261123-0001「鬼滅の刃」範囲 全体", flags: 0, allowed_mentions: { parse: [] } } });
  const badCb = cb.find((q) => q.url === `/api/v10/interactions/${bad.id}/${bad.token}/callback`)!;
  assert.equal(JSON.parse(badCb.body).data.flags, 64, "refusal is ephemeral");

  // notice timer → outbox delivered to the mock channel endpoint
  notice(env, "20261123-0001.received", "discord", CHANNEL, "受付通知");
  assert.equal([...timers.intervals.values()].find((x) => x.ms === 3000) !== undefined, true);
  const r = await bot.deliverNow();
  assert.equal(r?.sent, 1);
  const post = srv.requests.find((q) => q.url === `/api/v10/channels/${CHANNEL}/messages`)!;
  assert.equal(post.headers.authorization, `Bot ${TOKEN}`);
  assert.deepEqual(pendingIds(env), []);

  // op 7 → reconnect on a fresh socket, interactions keep working
  s.emit({ op: OP.RECONNECT });
  timers.runTimeouts();
  assert.equal(sockets.length, 2);
  sockets[1]!.emit({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  const q = interaction(MEMBER, "queue");
  sockets[1]!.emit({ op: OP.DISPATCH, t: "INTERACTION_CREATE", s: 1, d: q });
  await new Promise((r2) => setImmediate(r2));
  await bot.idle();
  assert.ok(srv.requests.some((x) => x.url === `/api/v10/interactions/${q.id}/${q.token}/callback`));
});

test("bot: a slow handler (e.g. takedown rebuild) gets a deferred response, then the result is PATCHed", async (t) => {
  const env = queueEnv(t);
  const srv = await mockServer(t, () => ({ status: 200, body: "{}" }));
  const cfg = testConfig({ api_base: `${srv.base}/api/v10` });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const svc = { ...fakeService(), takedown: async () => (await gate, { ok: true, text: "取り下げ完了" }) };
  const timers = fakeTimers();
  const sockets: FakeSocket[] = [];
  const bot = startBot({ cfg, service: svc, queueEnv: env, socketFactory: (u) => (sockets.push(new FakeSocket(u)), sockets.at(-1)!), timers, rejectLog: memLog(), log: () => {}, deferAfterMs: 2000 });
  t.after(() => bot.stop());
  const ix = interaction({ id: cfg.owner_id!, username: "owner" }, "takedown", { work: "w-1", reason: "要請" });
  sockets[0]!.emit({ op: OP.DISPATCH, t: "INTERACTION_CREATE", s: 1, d: ix });
  await new Promise((r) => setImmediate(r));
  const defer = [...timers.timeouts.values()].find((x) => x.ms === 2000)!;
  defer.fn(); // 2 s elapsed
  await new Promise((r) => setTimeout(r, 50));
  release();
  await bot.idle();
  assert.deepEqual(JSON.parse(srv.requests[0]!.body), { type: 5, data: { flags: 0 } });
  assert.equal(srv.requests[1]!.method, "PATCH");
  assert.equal(srv.requests[1]!.url, `/api/v10/webhooks/${ix.application_id}/${ix.token}/messages/@original`);
  assert.equal(JSON.parse(srv.requests[1]!.body).content, "取り下げ完了");
});
