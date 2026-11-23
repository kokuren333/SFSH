import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CALL_LOG_KEYS, FileCallLogger, MemoryCallLogger, buildCallLogLine, callLogFileFor } from "../src/model/callLog.ts";
import { parseClaudeEnvelope } from "../src/model/haikuCli.ts";
import { LoggedModelPort } from "../src/model/loggedPort.ts";
import { codexToolArgs, parseCodexRun } from "../src/model/lunaCli.ts";
import { ModelCallError, SchemaValidationError, type RawInvoker } from "../src/model/types.ts";
import { strictSchemaViolations } from "../src/model/validate.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "n"],
  properties: { ok: { type: "boolean" }, n: { type: "integer", minimum: 0 } },
};
const PROMPT = "SECRET-PROMPT-BODY please answer";
const fixedNow = () => new Date(2026, 10, 23, 2, 30, 0); // local time

function fakeInvoker(output: unknown, raw = JSON.stringify(output)): RawInvoker {
  return async () => ({
    output,
    raw,
    modelId: "fake-actual-1",
    reportedModelId: "fake-actual-1",
    tokens: { input: 10, output: 3 },
    costUsd: 0.001,
  });
}

test("call log line has exact key set and no prompt/output bodies", async () => {
  const log = new MemoryCallLogger();
  const port = new LoggedModelPort("haiku", "fake-req-1", fakeInvoker({ ok: true, n: 2 }), log, fixedNow);
  const r = await port.call({ task: "unit.test", prompt: PROMPT, schema: SCHEMA });
  assert.deepEqual(r.output, { ok: true, n: 2 });
  assert.equal(log.lines.length, 1);
  const line = log.lines[0];
  assert.deepEqual(Object.keys(line).sort(), [...CALL_LOG_KEYS].sort());
  assert.equal(line.ok, true);
  assert.equal(line.error, null);
  assert.equal(line.task, "unit.test");
  assert.equal(line.port, "haiku");
  assert.equal(line.modelId, "fake-actual-1");
  assert.equal(line.requestedModelId, "fake-req-1");
  assert.equal(line.reportedModelId, "fake-actual-1");
  assert.equal(line.modelIdSource, "cli_reported");
  assert.equal(line.jobId, null);
  assert.equal(line.tools, "none");
  assert.match(line.promptHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(line.schemaHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(line.promptChars, PROMPT.length);
  assert.equal(typeof line.outputChars, "number");
  assert.deepEqual(line.tokens, { input: 10, output: 3 });
  assert.equal(line.costUsd, 0.001);
  assert.match(line.ts, /^2026-11-23T02:30:00[+-]\d\d:\d\d$/);
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes("SECRET-PROMPT-BODY"), "prompt body must not be logged");
  assert.ok(!serialized.includes('"n":2'), "output body must not be logged");
});

test("schema hash is independent of key order", () => {
  const a = buildCallLogLine({ at: new Date(), task: "t", port: "luna", requestedModelId: "m", prompt: "p", schema: { a: 1, b: { c: 2, d: 3 } }, durationMs: 1 });
  const b = buildCallLogLine({ at: new Date(), task: "t", port: "luna", requestedModelId: "m", prompt: "p", schema: { b: { d: 3, c: 2 }, a: 1 }, durationMs: 1 });
  assert.equal(a.schemaHash, b.schemaHash);
});

test("invalid output → logged as failure, then SchemaValidationError thrown", async () => {
  const log = new MemoryCallLogger();
  const port = new LoggedModelPort("luna", "fake-req-2", fakeInvoker({ ok: "yes", n: -1 }), log, fixedNow);
  await assert.rejects(
    () => port.call({ task: "unit.invalid", prompt: PROMPT, schema: SCHEMA }),
    (e: unknown) => {
      assert.ok(e instanceof SchemaValidationError);
      assert.ok(e instanceof ModelCallError);
      assert.equal(e.kind, "schema_invalid");
      assert.ok(e.errors.length >= 2);
      return true;
    },
  );
  assert.equal(log.lines.length, 1);
  const line = log.lines[0];
  assert.equal(line.ok, false);
  assert.match(line.error ?? "", /^schema_invalid: /);
  assert.ok((line.error ?? "").length <= 200);
  assert.equal(line.modelId, "fake-actual-1");
  assert.deepEqual(line.tokens, { input: 10, output: 3 }, "tokens still recorded on schema failure");
});

test("transport error → logged as failure and rethrown as ModelCallError", async () => {
  const log = new MemoryCallLogger();
  const failing: RawInvoker = async () => {
    throw new ModelCallError("model_not_found", "luna", "gpt-x", "The 'gpt-x' model is not supported");
  };
  const port = new LoggedModelPort("luna", "gpt-x", failing, log, fixedNow);
  await assert.rejects(() => port.call({ task: "t", prompt: "p", schema: SCHEMA }), { kind: "model_not_found" });
  assert.equal(log.lines[0].ok, false);
  assert.equal(log.lines[0].modelId, "gpt-x");
  assert.equal(log.lines[0].outputChars, null);
  assert.match(log.lines[0].error ?? "", /^model_not_found: The 'gpt-x' model/);
});

test("FileCallLogger appends JSONL to logs/calls/<YYYYMMDD>.jsonl", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh_test_calls_"));
  try {
    const logger = new FileCallLogger(dir);
    const port = new LoggedModelPort("haiku", "m", fakeInvoker({ ok: true, n: 0 }), logger, fixedNow);
    await port.call({ task: "a", prompt: "p", schema: SCHEMA });
    await port.call({ task: "b", prompt: "p", schema: SCHEMA });
    const file = callLogFileFor(dir, fixedNow());
    assert.equal(path.basename(file), "20261123.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.task), ["a", "b"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseClaudeEnvelope: structured_output, usage, cost, actual model", () => {
  const env = {
    is_error: false,
    result: "",
    structured_output: { ok: true },
    total_cost_usd: 0.002,
    usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
    modelUsage: { "claude-haiku-5-5": {} },
  };
  const r = parseClaudeEnvelope("claude-haiku-5-5", 0, JSON.stringify(env), "");
  assert.deepEqual(r.output, { ok: true });
  assert.equal(r.modelId, "claude-haiku-5-5");
  assert.equal(r.costUsd, 0.002);
  assert.deepEqual(r.tokens, { input: 2, output: 4, cacheRead: 5, cacheWrite: 6 });
  // falls back to JSON.parse(result)
  const r2 = parseClaudeEnvelope("m", 0, JSON.stringify({ result: '{"ok":false}', usage: {} }), "");
  assert.deepEqual(r2.output, { ok: false });
  assert.throws(() => parseClaudeEnvelope("m", 1, JSON.stringify({ is_error: true, result: "boom" }), ""), { kind: "exit" });
});

test("parseCodexRun: usage from turn.completed; model_not_found detection", () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"x"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7,"reasoning_output_tokens":2}}',
  ].join("\n");
  const r = parseCodexRun("gpt-6-luna", 0, stdout, "", '{"ok":true}');
  assert.deepEqual(r.output, { ok: true });
  assert.deepEqual(r.tokens, { input: 100, cacheRead: 40, output: 7, reasoning: 2 });
  const errStdout = '{"type":"error","message":"{\\"code\\":\\"model_not_found\\"}"}';
  assert.throws(() => parseCodexRun("gpt-6.2-luna", 1, errStdout, "", null), { kind: "model_not_found" });
  assert.throws(() => parseCodexRun("gpt-6-luna", 1, "", "something broke", null), { kind: "exit" });
});

test("strictSchemaViolations flags non-strict schemas (codex requirement)", () => {
  assert.deepEqual(strictSchemaViolations(SCHEMA), []);
  const loose = { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "object", properties: {} } } };
  const v = strictSchemaViolations(loose);
  assert.ok(v.some((s) => s.startsWith("#: additionalProperties")));
  assert.ok(v.some((s) => s.includes("/properties/b: not listed in required")));
  assert.ok(v.some((s) => s.startsWith("#/properties/b: additionalProperties")));
});

test("call log distinguishes requested vs CLI-reported model id (PM 所見 a)", async () => {
  const log = new MemoryCallLogger();
  const lunaLike: RawInvoker = async () => ({
    output: { ok: true, n: 1 },
    raw: '{"ok":true,"n":1}',
    modelId: "gpt-6-luna",
    reportedModelId: null,
    toolEvents: {
      webSearch: [
        { itemId: "a", action: "search", query: "q", url: null, results: [] },
        { itemId: "b", action: "open_page", query: null, url: "https://x.example/", results: [] },
      ],
      otherToolItems: 0,
      otherToolTypes: [],
    },
    tokens: {},
    costUsd: null,
  });
  const port = new LoggedModelPort("luna", "gpt-6-luna", lunaLike, log, fixedNow);
  const r = await port.call({ task: "t", prompt: "p", schema: SCHEMA, tools: "web_search", jobId: "J1" });
  assert.equal(r.reportedModelId, null);
  assert.equal(r.toolEvents?.webSearch.length, 2);
  const line = log.lines[0];
  assert.equal(line.modelId, "gpt-6-luna");
  assert.equal(line.requestedModelId, "gpt-6-luna");
  assert.equal(line.reportedModelId, null);
  assert.equal(line.modelIdSource, "requested");
  assert.equal(line.jobId, "J1");
  assert.equal(line.tools, "web_search");
  assert.equal(line.webSearches, 1);
  assert.equal(line.openPages, 1);
});

test("codexToolArgs: none disables web_search and the apps/browser/computer fallbacks", () => {
  assert.deepEqual(codexToolArgs("none"), ["-c", "web_search=disabled", "--disable", "apps", "--disable", "browser_use", "--disable", "computer_use"]);
  assert.deepEqual(codexToolArgs("web_search").slice(0, 2), ["-c", "web_search=live"]);
  assert.ok(codexToolArgs("web_search").includes("apps"));
});

test("parseCodexRun captures web_search items (search + open_page) and counts other tool items", () => {
  const ev = (o: object) => JSON.stringify(o);
  const stdout = [
    ev({ type: "item.started", item: { id: "w1", type: "web_search", query: "", action: { type: "other" } } }),
    ev({
      type: "item.completed",
      item: {
        id: "w1",
        type: "web_search",
        query: "q1",
        action: { type: "search", query: "q1" },
        results: [{ type: "text_result", domain: "a.example", ref_id: "r0", snippet: "s", title: "T", url: "https://a.example/p" }],
      },
    }),
    ev({ type: "item.completed", item: { id: "w2", type: "web_search", query: "https://b.example/", action: { type: "open_page", url: "https://b.example/" }, results: [] } }),
    ev({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "codex_apps" } }),
    ev({ type: "item.completed", item: { id: "x", type: "agent_message", text: "hi" } }),
    ev({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n");
  const r = parseCodexRun("gpt-6-luna", 0, stdout, "", '{"ok":true}');
  assert.equal(r.reportedModelId, null);
  assert.equal(r.toolEvents?.webSearch.length, 2);
  assert.deepEqual(r.toolEvents?.webSearch[0], {
    itemId: "w1",
    action: "search",
    query: "q1",
    url: null,
    results: [{ url: "https://a.example/p", title: "T", domain: "a.example", snippet: "s" }],
  });
  assert.equal(r.toolEvents?.webSearch[1].action, "open_page");
  assert.equal(r.toolEvents?.webSearch[1].url, "https://b.example/");
  assert.equal(r.toolEvents?.otherToolItems, 1);
  assert.deepEqual(r.toolEvents?.otherToolTypes, ["mcp_tool_call"]);
});

test("transient CLI exit is retried once at the call level; deterministic failures are not (CP-035 d)", async () => {
  const log = new MemoryCallLogger();
  let n = 0;
  const flaky: RawInvoker = async () => {
    n++;
    if (n === 1) throw new ModelCallError("exit", "haiku", "m", "exit 1");
    return { output: { ok: true, n: 1 }, raw: "", modelId: "m", reportedModelId: "m", tokens: {}, costUsd: null };
  };
  const port = new LoggedModelPort("haiku", "m", flaky, log, fixedNow, { transientRetries: 1, delayMs: 0 });
  const r = await port.call({ task: "t", prompt: "p", schema: SCHEMA });
  assert.deepEqual(r.output, { ok: true, n: 1 });
  assert.equal(n, 2);
  assert.deepEqual(log.lines.map((l) => l.ok), [false, true]);
  assert.match(log.lines[0].error ?? "", /^exit: exit 1/);

  let m = 0;
  const always: RawInvoker = async () => {
    m++;
    throw new ModelCallError("exit", "haiku", "m", "exit 1");
  };
  const p2 = new LoggedModelPort("haiku", "m", always, new MemoryCallLogger(), fixedNow, { transientRetries: 1, delayMs: 0 });
  await assert.rejects(() => p2.call({ task: "t", prompt: "p", schema: SCHEMA }), { kind: "exit" });
  assert.equal(m, 2);

  let k = 0;
  const notFound: RawInvoker = async () => {
    k++;
    throw new ModelCallError("model_not_found", "luna", "x", "nope");
  };
  const p3 = new LoggedModelPort("luna", "x", notFound, new MemoryCallLogger(), fixedNow, { transientRetries: 1, delayMs: 0 });
  await assert.rejects(() => p3.call({ task: "t", prompt: "p", schema: SCHEMA }), { kind: "model_not_found" });
  assert.equal(k, 1);

  let v = 0;
  const invalid: RawInvoker = async () => {
    v++;
    return { output: { wrong: 1 }, raw: "", modelId: "m", reportedModelId: null, tokens: {}, costUsd: null };
  };
  const p4 = new LoggedModelPort("haiku", "m", invalid, new MemoryCallLogger(), fixedNow, { transientRetries: 1, delayMs: 0 });
  await assert.rejects(() => p4.call({ task: "t", prompt: "p", schema: SCHEMA }), { kind: "schema_invalid" });
  assert.equal(v, 1);
});
