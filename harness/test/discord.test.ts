/**
 * WP-4.4 Discord bot: config + production gate, command definition, interaction handler (permissions, mapping to
 * SfshService, import attachments, truncation), `sfsh discord` CLI gate. All against fakes / 127.0.0.1 mocks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { discordCommand } from "../src/commands/discord.ts";
import { commandDefinitions, OPT, SUBCOMMANDS } from "../src/discord/commands.ts";
import { assertProductionAllowed, configSummary, DEFAULT_DISCORD_CONFIG, loadDiscordConfig, parseDiscordConfig, parseDotenv } from "../src/discord/config.ts";
import { createAttachmentFetcher, fileRejectLog, handleInteraction, truncateForDiscord, type HandlerContext } from "../src/discord/handler.ts";
import { CHANNEL, fakeService, interaction, MEMBER, memLog, mockServer, OTHER_MEMBER, OWNER, queueEnv, STRANGER, testConfig, tmpDir, TOKEN } from "../src/discord/testkit.ts";
import { comparableRequest, submitJob } from "../src/queue/request.ts";
import { listJobs, type QueueEnv } from "../src/queue/store.ts";
import type { JobRequest, OpResult, SfshService } from "../src/queue/types.ts";

const noFetch = async () => {
  throw new Error("fetchAttachment must not be called");
};

function ctx(service: SfshService, over: Partial<HandlerContext> = {}): HandlerContext & { log: ReturnType<typeof memLog> } {
  return { cfg: testConfig(), service, log: memLog(), fetchAttachment: noFetch, now: () => new Date("2026-11-23T10:00:00+09:00"), ...over } as HandlerContext & { log: ReturnType<typeof memLog> };
}

/** Minimal service adapter over the REAL submitJob (the orchestrator wires the real service later). */
function submitAdapter(env: QueueEnv): SfshService & { calls: number } {
  const base = fakeService();
  const svc = {
    ...base,
    calls: 0,
    request(input: Parameters<SfshService["request"]>[0]): OpResult {
      svc.calls++;
      const r = submitJob(env, input, new Date("2026-11-23T10:00:00+09:00"));
      return r.ok ? { ok: true, text: `受付: ${r.job!.job_id}`, data: r.job } : { ok: false, text: r.errors.join(" / ") };
    },
  };
  return svc;
}

// ---------------------------------------------------------------- (i) same JobRequest from CLI and Discord

test("(i) /sfsh request by an allowed user writes the same JobRequest as the CLI (real submitJob, comparableRequest)", async (t) => {
  const cases = [
    { work: "魔法少女まどか☆マギカ", range: "1-3話", medium: "anime", note: "テスト" },
    { work: "ちはやふる", range: "第2シーズン", medium: null, note: null },
    { work: "鬼滅の刃", range: "「無限列車」編", medium: "Manga", note: "  空白  " },
    { work: "謎の作品", range: "そのへん", medium: null, note: null }, // unparsable → range null (clarifying later)
  ];
  for (const c of cases) {
    const envD = queueEnv(t);
    const envC = queueEnv(t);
    const svc = submitAdapter(envD);
    const opts: Record<string, string> = { work: c.work, range: c.range };
    if (c.medium) opts.medium = c.medium;
    if (c.note) opts.note = c.note;
    const r = await handleInteraction(interaction(MEMBER, "request", opts), ctx(svc));
    assert.ok(r, "reply");
    assert.equal(svc.calls, 1);
    assert.equal(r.ephemeral, false);
    assert.match(r.content, /受付: \d{8}-\d{4}/);
    const cli = submitJob(envC, { origin: "cli", work: c.work, range: c.range, medium: c.medium, note: c.note }, new Date("2026-11-23T10:00:00+09:00"));
    assert.ok(cli.ok);
    const dJobs = listJobs(envD);
    const cJobs = listJobs(envC);
    assert.equal(dJobs.length, 1);
    assert.equal(cJobs.length, 1);
    // compare the files on disk, not the in-memory objects
    const dFile = JSON.parse(fs.readFileSync(dJobs[0]!.file, "utf8")) as JobRequest;
    const cFile = JSON.parse(fs.readFileSync(cJobs[0]!.file, "utf8")) as JobRequest;
    assert.deepEqual(comparableRequest(dFile), comparableRequest(cFile), c.work);
    assert.equal(dFile.origin, "discord");
    assert.deepEqual(dFile.requester, { id: MEMBER.id, name: MEMBER.username });
    assert.equal(dFile.reply_to, CHANNEL);
    assert.equal(cFile.origin, "cli");
  }
});

// ---------------------------------------------------------------- (ii) not in the allow list

test("(ii) a user outside the allow list: no queue file, service not called, rejected.jsonl record (not_allowed)", async (t) => {
  const env = queueEnv(t);
  const svc = submitAdapter(env);
  const logFile = path.join(tmpDir(t), "logs", "discord", "rejected.jsonl");
  const ix = interaction(STRANGER, "request", { work: "作品X", range: "全体" });
  const r = await handleInteraction(ix, { cfg: testConfig(), service: svc, log: fileRejectLog(logFile), fetchAttachment: noFetch });
  assert.deepEqual(r, { content: "このコマンドを使う権限がありません。", ephemeral: true });
  assert.equal(svc.calls, 0);
  assert.equal(listJobs(env).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(env.queueDir, "inbox")), []);
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.reason, "not_allowed");
  assert.equal(rec.user_id, STRANGER.id);
  assert.equal(rec.user_name, STRANGER.username);
  assert.equal(rec.command, "sfsh request");
  assert.deepEqual(rec.options, { work: "作品X", range: "全体" });
  assert.equal(rec.channel_id, CHANNEL);
  assert.ok(rec.at);
  assert.ok(!lines[0]!.includes(ix.token!), "interaction token is not logged");

  // every subcommand is refused for a stranger, and nothing reaches the service
  const svc2 = fakeService();
  const c = ctx(svc2);
  for (const sub of SUBCOMMANDS) {
    const rr = await handleInteraction(interaction(STRANGER, sub, { work: "w", reason: "r", job_id: "20261123-0001" }), c);
    assert.equal(rr?.ephemeral, true, sub);
  }
  assert.equal(svc2.calls.length, 0);
  assert.equal(c.log.records.length, SUBCOMMANDS.length);
  assert.ok(c.log.records.every((x) => x.reason === "not_allowed"));

  // default config (owner null, empty list) → everyone refused
  const c3 = ctx(svc2, { cfg: parseDiscordConfig({}, null) });
  assert.equal((await handleInteraction(interaction(OWNER, "queue"), c3))?.ephemeral, true);
  assert.equal(svc2.calls.length, 0);
  // user in a DM (interaction.user instead of member.user) is checked the same way
  const dm = interaction(STRANGER, "queue", {}, { member: undefined, user: { id: STRANGER.id, username: STRANGER.username }, guild_id: undefined });
  await handleInteraction(dm, c);
  assert.equal(svc2.calls.length, 0);
});

// ---------------------------------------------------------------- (iii) owner-only

test("(iii) hold/release/takedown: allowed non-owner rejected + logged (owner_only), owner reaches the service", async () => {
  const svc = fakeService();
  const c = ctx(svc);
  const args = { hold: { work: "w-1", reason: "苦情" }, release: { work: "w-1" }, takedown: { work: "w-1", reason: "権利者要請" } } as const;
  for (const sub of ["hold", "release", "takedown"] as const) {
    const r = await handleInteraction(interaction(MEMBER, sub, args[sub]), c);
    assert.deepEqual(r, { content: "このコマンドはオーナーだけが実行できます。", ephemeral: true });
  }
  assert.equal(svc.calls.length, 0);
  assert.deepEqual(
    c.log.records.map((x) => [x.reason, x.command, x.user_id]),
    [
      ["owner_only", "sfsh hold", MEMBER.id],
      ["owner_only", "sfsh release", MEMBER.id],
      ["owner_only", "sfsh takedown", MEMBER.id],
    ],
  );
  for (const sub of ["hold", "release", "takedown"] as const) {
    const r = await handleInteraction(interaction(OWNER, sub, args[sub]), c);
    assert.equal(r?.content, `${sub} ok`);
  }
  assert.deepEqual(
    svc.calls.map((x) => [x.method, ...x.args]),
    [
      ["hold", "w-1", "苦情", { id: OWNER.id, name: OWNER.username, origin: "discord", is_owner: true }],
      ["release", "w-1", null, { id: OWNER.id, name: OWNER.username, origin: "discord", is_owner: true }],
      ["takedown", "w-1", "権利者要請", { id: OWNER.id, name: OWNER.username, origin: "discord", is_owner: true }],
    ],
  );
  assert.equal(c.log.records.length, 3, "owner calls are not logged as rejects");
});

// ---------------------------------------------------------------- (iv) cancel by another non-owner

test("(iv) cancel: service decides; not_permitted → refusal + log; actor carries is_owner", async () => {
  const deny = fakeService({ cancel: { ok: false, text: "このジョブを取り消せるのは投入者かオーナーだけです。", data: { reason: "not_permitted" } } });
  const c = ctx(deny);
  const r = await handleInteraction(interaction(OTHER_MEMBER, "cancel", { job_id: "20261123-0001" }), c);
  assert.deepEqual(r, { content: "このジョブを取り消せるのは投入者かオーナーだけです。", ephemeral: true });
  assert.deepEqual(deny.calls[0]!.args, [{ job_id: "20261123-0001" }, { id: OTHER_MEMBER.id, name: OTHER_MEMBER.username, origin: "discord", is_owner: false }]);
  assert.equal(c.log.records.length, 1);
  assert.equal(c.log.records[0]!.reason, "not_permitted");
  assert.deepEqual(c.log.records[0]!.options, { job_id: "20261123-0001" });

  // other failure (e.g. already finished) is not a permission reject
  const fin = fakeService({ cancel: { ok: false, text: "終了済み", data: { reason: "terminal" } } });
  const c2 = ctx(fin);
  await handleInteraction(interaction(MEMBER, "cancel", { batch_id: "b-20261123-0001" }), c2);
  assert.deepEqual(fin.calls[0]!.args[0], { batch_id: "b-20261123-0001" });
  assert.equal(c2.log.records.length, 0);

  // owner cancel → is_owner true, ok reply
  const ok = fakeService();
  const r3 = await handleInteraction(interaction(OWNER, "cancel", { job_id: "20261123-0002" }), ctx(ok));
  assert.equal(r3?.content, "cancel ok");
  assert.equal((ok.calls[0]!.args[1] as { is_owner: boolean }).is_owner, true);

  // neither / both ids → usage, service not called
  const none = fakeService();
  assert.equal((await handleInteraction(interaction(MEMBER, "cancel"), ctx(none)))?.ephemeral, true);
  assert.equal((await handleInteraction(interaction(MEMBER, "cancel", { job_id: "20261123-0001", batch_id: "b" }), ctx(none)))?.ephemeral, true);
  assert.equal(none.calls.length, 0);
});

// ---------------------------------------------------------------- other mappings

test("status / queue / answer map to the service with the right arguments", async () => {
  const svc = fakeService();
  const c = ctx(svc);
  const st = await handleInteraction(interaction(MEMBER, "status", { id: "20261123-0007" }), c);
  assert.equal(st?.ephemeral, true);
  await handleInteraction(interaction(MEMBER, "status", { id: "b-20261123-0001" }), c);
  await handleInteraction(interaction(MEMBER, "status"), c);
  await handleInteraction(interaction(MEMBER, "queue"), c);
  const an = await handleInteraction(interaction(MEMBER, "answer", { job_id: "20261123-0007", pick: 2, range: "1-3巻" }), c);
  assert.equal(an?.ephemeral, false);
  assert.equal((await handleInteraction(interaction(MEMBER, "answer", { job_id: "20261123-0007" }), c))?.ephemeral, true);
  assert.deepEqual(
    svc.calls.map((x) => [x.method, ...x.args]),
    [
      ["status", { job_id: "20261123-0007" }],
      ["status", { batch_id: "b-20261123-0001" }],
      ["status", {}],
      ["queue"],
      ["answer", "20261123-0007", { pick: 2, range: "1-3巻" }, { id: MEMBER.id, name: MEMBER.username, origin: "discord", is_owner: false }],
    ],
  );
  // service failure / exception → ephemeral reply, no crash
  const bad = fakeService({ request: { ok: false, text: "作品名が空です" } });
  assert.deepEqual(await handleInteraction(interaction(MEMBER, "request", { work: "x", range: "全体" }), ctx(bad)), { content: "作品名が空です", ephemeral: true });
  const thrower = { ...fakeService(), queue: () => { throw new Error("boom"); } } as SfshService;
  const tr = await handleInteraction(interaction(MEMBER, "queue"), ctx(thrower));
  assert.equal(tr?.ephemeral, true);
  assert.match(tr!.content, /boom/);
  // non-command interactions are ignored
  assert.equal(await handleInteraction({ id: "1", type: 3 }, ctx(svc)), null);
  assert.equal(await handleInteraction({ id: "1", type: 2, data: { name: "other" } }, ctx(svc)), null);
});

// ---------------------------------------------------------------- (v) import

test("(v) import: attachment downloaded from a mock server, size cap enforced, wrong extension refused", async (t) => {
  const body = Buffer.from("鬼滅の刃\nちはやふる\n", "utf8");
  const big = Buffer.alloc(1000, 0x41);
  const srv = await mockServer(t, (req) => {
    if (req.url === "/list.txt") return { status: 200, headers: { "content-type": "text/plain" }, body };
    if (req.url === "/big-chunked.csv") return { status: 200, headers: { "content-type": "text/plain" }, chunks: [big.subarray(0, 40), big.subarray(40, 500), big.subarray(500)] };
    if (req.url === "/big-len.txt") return { status: 200, headers: { "content-type": "text/plain", "content-length": String(big.length) }, body: big };
    return { status: 404, body: "" };
  });
  const fetcher = createAttachmentFetcher({ allowedHosts: ["127.0.0.1"], allowHttp: true });
  const cfg = testConfig({ attachment_max_bytes: 64 });
  const att = (filename: string, url: string, size: number) => ({ resolved: { attachments: { "9001": { id: "9001", filename, size, url: srv.base + url } } } });
  const imp = (filename: string, url: string, size: number, opts: Record<string, string> = {}) => {
    const ix = interaction(MEMBER, "import", { file: "9001", ...opts });
    ix.data = { ...ix.data!, ...att(filename, url, size) };
    return ix;
  };

  const svc = fakeService({ importFile: { ok: true, text: "バッチ受付: 2件" } });
  const c = ctx(svc, { cfg, fetchAttachment: fetcher });
  const ok = await handleInteraction(imp("list.txt", "/list.txt", body.length, { range: "全体", medium: "manga" }), c);
  assert.deepEqual(ok, { content: "バッチ受付: 2件", ephemeral: false });
  assert.equal(svc.calls.length, 1);
  const a = svc.calls[0]!.args[0] as { fileName: string; bytes: Uint8Array; range: string; medium: string; origin: string; requester: unknown; reply_to: string; priority: unknown };
  assert.equal(a.fileName, "list.txt");
  assert.deepEqual(Buffer.from(a.bytes), body);
  assert.equal(a.range, "全体");
  assert.equal(a.medium, "manga");
  assert.equal(a.origin, "discord");
  assert.equal(a.priority, null);
  assert.deepEqual(a.requester, { id: MEMBER.id, name: MEMBER.username });
  assert.equal(a.reply_to, CHANNEL);

  // actual bytes exceed the cap although the declared size is small (streamed, no content-length)
  const before = srv.requests.length;
  const r1 = await handleInteraction(imp("big.csv", "/big-chunked.csv", 10), c);
  assert.equal(r1?.ephemeral, true);
  assert.match(r1!.content, /大きすぎます（上限 64 バイト）/);
  // content-length over the cap
  const r2 = await handleInteraction(imp("big.txt", "/big-len.txt", 10), c);
  assert.match(r2!.content, /大きすぎます/);
  assert.equal(srv.requests.length, before + 2);
  // declared size over the cap → refused before any download
  const r3 = await handleInteraction(imp("big.txt", "/big-len.txt", 1000), c);
  assert.match(r3!.content, /大きすぎます/);
  // wrong extension → refused before any download
  const r4 = await handleInteraction(imp("list.pdf", "/list.txt", 10), c);
  assert.deepEqual(r4, { content: "添付できるのは .txt と .csv だけです。", ephemeral: true });
  const r5 = await handleInteraction(imp("list.txt.exe", "/list.txt", 10), c);
  assert.equal(r5?.ephemeral, true);
  assert.equal(srv.requests.length, before + 2, "no download for refused files");
  // the default fetcher only accepts Discord's CDN over https
  const strict = ctx(svc, { cfg, fetchAttachment: createAttachmentFetcher() });
  const r6 = await handleInteraction(imp("list.txt", "/list.txt", 10), strict);
  assert.match(r6!.content, /受け付けません/);
  assert.equal(srv.requests.length, before + 2);
  // missing attachment
  const noAtt = interaction(MEMBER, "import", { file: "777" });
  assert.equal((await handleInteraction(noAtt, c))?.ephemeral, true);
  assert.equal(svc.calls.length, 1, "importFile only called for the valid file");
});

// ---------------------------------------------------------------- (ix) truncation

test("(ix) replies stay under 2000 chars (surrogate pairs not split)", async () => {
  const long = "あ".repeat(5000);
  const svc = fakeService({ queue: { ok: true, text: long } });
  const r = await handleInteraction(interaction(MEMBER, "queue"), ctx(svc));
  assert.ok(r!.content.length <= 2000);
  assert.match(r!.content, /以下省略/);
  for (let n = 1990; n <= 2010; n++) {
    const s = truncateForDiscord("x".repeat(n - 2000 + 1990) + "😀".repeat(20));
    assert.ok(s.length <= 2000);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s), "no lone high surrogate");
  }
  assert.equal(truncateForDiscord("short"), "short");
  assert.equal(truncateForDiscord("y".repeat(2000)).length, 2000);
});

// ---------------------------------------------------------------- command definition

test("command definition: /sfsh with the §4.2 subcommands + answer, Discord constraints honoured", () => {
  const defs = commandDefinitions();
  assert.equal(defs.length, 1);
  const cmd = defs[0]!;
  assert.equal(cmd.name, "sfsh");
  assert.deepEqual(SUBCOMMANDS, ["request", "import", "status", "queue", "cancel", "answer", "hold", "release", "takedown"]);
  const names = (sub: string) => cmd.options.find((o) => o.name === sub)!.options!.map((o) => `${o.name}${o.required ? "!" : ""}`);
  assert.deepEqual(names("request"), ["work!", "range!", "medium", "note"]);
  assert.deepEqual(names("import"), ["file!", "range", "medium"]);
  assert.deepEqual(names("status"), ["id"]);
  assert.deepEqual(names("queue"), []);
  assert.deepEqual(names("cancel"), ["job_id", "batch_id"]);
  assert.deepEqual(names("answer"), ["job_id!", "pick", "work", "medium", "range"]);
  assert.deepEqual(names("hold"), ["work!", "reason!"]);
  assert.deepEqual(names("release"), ["work!"]);
  assert.deepEqual(names("takedown"), ["work!", "reason!"]);
  assert.equal(cmd.options.find((o) => o.name === "import")!.options![0]!.type, OPT.ATTACHMENT);
  const walk = (o: { name: string; description: string; options?: { name: string; description: string; required?: boolean; options?: unknown[] }[] }) => {
    assert.match(o.name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, o.name);
    let optionalSeen = false;
    for (const c of o.options ?? []) {
      if (!c.required) optionalSeen = true;
      else assert.ok(!optionalSeen, `required after optional in ${o.name}`);
      walk(c as Parameters<typeof walk>[0]);
    }
  };
  walk(cmd);
  assert.ok(JSON.stringify(defs).length < 8000);
});

// ---------------------------------------------------------------- (viii) production gate + CLI

test("(viii) config: defaults cannot connect; assertProductionAllowed refuses unless enabled + token + owner", (t) => {
  // the tracked harness/config/discord.json is the default (no .env is read here)
  const repoCfg = loadDiscordConfig({ env: {}, dotenvPath: null });
  assert.deepEqual({ ...repoCfg, token: undefined }, { ...DEFAULT_DISCORD_CONFIG, token: undefined });
  assert.throws(() => assertProductionAllowed(repoCfg), /U-04/);
  assert.throws(() => assertProductionAllowed(testConfig({ production_enabled: false })), /production_enabled/);
  assert.throws(() => assertProductionAllowed(testConfig({ production_enabled: true }, null)), /DISCORD_BOT_TOKEN/);
  assert.throws(() => assertProductionAllowed(testConfig({ production_enabled: true, owner_id: null })), /owner_id/);
  assert.doesNotThrow(() => assertProductionAllowed(testConfig({ production_enabled: true })));

  // token from env, else from a .env file; summary never prints it
  const d = tmpDir(t);
  const cfgFile = path.join(d, "discord.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ owner_id: OWNER.id, allowed_user_ids: [MEMBER.id], production_enabled: true }));
  const dot = path.join(d, ".env");
  fs.writeFileSync(dot, `# comment\nOTHER=1\nexport DISCORD_BOT_TOKEN="from-dotenv-secret"\n`);
  const fromDot = loadDiscordConfig({ configPath: cfgFile, env: {}, dotenvPath: dot });
  assert.equal(fromDot.token, "from-dotenv-secret");
  assert.equal(loadDiscordConfig({ configPath: cfgFile, env: { DISCORD_BOT_TOKEN: "from-env" }, dotenvPath: dot }).token, "from-env");
  assert.equal(loadDiscordConfig({ configPath: cfgFile, env: {}, dotenvPath: null }).token, null);
  assert.ok(!JSON.stringify(configSummary(fromDot)).includes("from-dotenv-secret"));
  assert.deepEqual(configSummary(fromDot).allowed_user_ids, [MEMBER.id, OWNER.id]);
  assert.deepEqual(parseDotenv("A=1\nB='x y'\nC=z # c\n#D=4\nbad line"), { A: "1", B: "x y", C: "z" });
  // numeric snowflakes are refused (precision loss)
  assert.throws(() => parseDiscordConfig({ owner_id: 100000000000000001 }, null), /文字列/);
});

test("(viii) `sfsh discord serve` / `register` exit 2 with the default config and attempt no connection", async () => {
  const out: string[] = [];
  const err: string[] = [];
  let sockets = 0;
  let fetches = 0;
  let services = 0;
  const deps = {
    loadConfig: () => parseDiscordConfig({ ...DEFAULT_DISCORD_CONFIG }, null),
    socketFactory: () => {
      sockets++;
      throw new Error("no socket in tests");
    },
    fetchImpl: (async () => {
      fetches++;
      throw new Error("no fetch in tests");
    }) as typeof fetch,
    service: () => {
      services++;
      return fakeService();
    },
    out: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
    until: Promise.resolve(),
  };
  assert.equal(await discordCommand(["serve"], deps), 2);
  assert.match(err.join("\n"), /U-04/);
  assert.match(err.join("\n"), /接続しません/);
  assert.equal(await discordCommand(["register"], deps), 2);
  // enabled but no token → still refused
  assert.equal(await discordCommand(["serve"], { ...deps, loadConfig: () => testConfig({ production_enabled: true }, null) }), 2);
  assert.equal(sockets + fetches + services, 0, "no connection attempted");

  // dry-run prints the summary only (token masked), exit 0, still no connection
  out.length = 0;
  assert.equal(await discordCommand(["serve", "--dry-run"], { ...deps, loadConfig: () => testConfig() }), 0);
  const printed = out.join("\n");
  assert.match(printed, /production_enabled/);
  assert.match(printed, /U-04/);
  assert.ok(!printed.includes(TOKEN));
  assert.equal(sockets + fetches + services, 0);

  // commands prints the JSON; usage errors are 2
  out.length = 0;
  assert.equal(await discordCommand(["commands"], deps), 0);
  assert.equal(JSON.parse(out.join("\n"))[0].name, "sfsh");
  assert.equal(await discordCommand([], deps), 2);
  assert.equal(await discordCommand(["serve", "--bogus"], deps), 2);
});

test("`sfsh discord register` (gated) PUTs the command JSON to the mock REST; serve connects only to the injected socket", async (t) => {
  const srv = await mockServer(t, () => ({ status: 200, body: "[]" }));
  const cfg = testConfig({ production_enabled: true, api_base: `${srv.base}/api/v10`, application_id: "400000000000000001", guild_id: "500000000000000001" });
  const out: string[] = [];
  const deps = { loadConfig: () => cfg, out: (s: string) => void out.push(s), err: (s: string) => void out.push(s) };
  assert.equal(await discordCommand(["register"], deps), 0);
  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0]!;
  assert.equal(req.method, "PUT");
  assert.equal(req.url, "/api/v10/applications/400000000000000001/guilds/500000000000000001/commands");
  assert.equal(req.headers.authorization, `Bot ${TOKEN}`);
  assert.deepEqual(JSON.parse(req.body), commandDefinitions());
  // application_id missing → 2
  assert.equal(await discordCommand(["register"], { ...deps, loadConfig: () => testConfig({ production_enabled: true, api_base: `${srv.base}/api/v10` }) }), 2);
  assert.equal(srv.requests.length, 1);

  // serve with production allowed: uses only the injected socket factory, stops when `until` resolves
  const urls: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((res) => (stop = res));
  const p = discordCommand(["serve"], {
    ...deps,
    queueEnv: queueEnv(t),
    service: fakeService(),
    socketFactory: (url) => {
      urls.push(url);
      return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    },
    until,
  });
  await new Promise((r) => setImmediate(r));
  stop();
  assert.equal(await p, 0);
  assert.deepEqual(urls, [cfg.gateway_url]);
});
