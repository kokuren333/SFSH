import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCallLogger } from "../src/model/callLog.ts";
import { LoggedModelPort } from "../src/model/loggedPort.ts";
import { formatProbeTable, probeModels, type PortFactory } from "../src/model/probe.ts";
import { ModelCallError, type PortName } from "../src/model/types.ts";

/** Fake factory: ids in `alive` answer {ok:true}; others fail with model_not_found. Records call order. */
function fakeFactory(alive: Set<string>, calls: string[], log = new MemoryCallLogger()): PortFactory {
  return (port: PortName, modelId: string) =>
    new LoggedModelPort(
      port,
      modelId,
      async () => {
        calls.push(`${port}:${modelId}`);
        if (!alive.has(modelId)) throw new ModelCallError("model_not_found", port, modelId, "model_not_found");
        return { output: { ok: true }, raw: '{"ok":true}', modelId, reportedModelId: null, tokens: {}, costUsd: null };
      },
      log,
    );
}

const CONFIG = { haiku: ["claude-haiku-5-5"], luna: ["gpt-6.2-luna", "gpt-6-luna"] };

test("luna: first candidate unavailable → adopts second (V-1 situation)", async () => {
  const calls: string[] = [];
  const o = await probeModels(CONFIG, fakeFactory(new Set(["gpt-6-luna", "claude-haiku-5-5"]), calls));
  assert.deepEqual(o.adopted, { luna: "gpt-6-luna", haiku: "claude-haiku-5-5" });
  assert.deepEqual(o.failed, []);
  assert.deepEqual(calls, ["luna:gpt-6.2-luna", "luna:gpt-6-luna", "haiku:claude-haiku-5-5"]);
});

test("luna: preferred id available → adopted, later candidates skipped (not called)", async () => {
  const calls: string[] = [];
  const o = await probeModels(CONFIG, fakeFactory(new Set(["gpt-6.2-luna", "gpt-6-luna", "claude-haiku-5-5"]), calls));
  assert.equal(o.adopted.luna, "gpt-6.2-luna");
  assert.ok(!calls.includes("luna:gpt-6-luna"));
  const skipped = o.attempts.find((a) => a.modelId === "gpt-6-luna");
  assert.equal(skipped?.skipped, true);
});

test("luna: none responds → failed, no fallback to other tiers", async () => {
  const calls: string[] = [];
  const o = await probeModels(CONFIG, fakeFactory(new Set(["claude-haiku-5-5", "gpt-6.2-sol", "gpt-6-terra"]), calls));
  assert.equal(o.adopted.luna, undefined);
  assert.deepEqual(o.failed, ["luna"]);
  // only configured ids were ever tried
  assert.deepEqual(calls, ["luna:gpt-6.2-luna", "luna:gpt-6-luna", "haiku:claude-haiku-5-5"]);
});

test("schema-invalid probe answer counts as not responding", async () => {
  const log = new MemoryCallLogger();
  const factory: PortFactory = (port, modelId) =>
    new LoggedModelPort(port, modelId, async () => ({ output: { ok: "yes" }, raw: "", modelId, reportedModelId: null, tokens: {}, costUsd: null }), log);
  const o = await probeModels({ haiku: ["h"], luna: ["l"] }, factory, { ports: ["haiku"] });
  assert.deepEqual(o.failed, ["haiku"]);
  assert.match(o.attempts[0].error ?? "", /^schema_invalid/);
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].task, "models.probe");
});

test("formatProbeTable renders one row per attempt", async () => {
  const o = await probeModels(CONFIG, fakeFactory(new Set(["gpt-6-luna", "claude-haiku-5-5"]), []));
  const t = formatProbeTable(o);
  assert.equal(t.split("\n").length, 2 + 3);
  assert.match(t, /gpt-6\.2-luna\s+FAIL/);
  assert.match(t, /gpt-6-luna\s+OK/);
});

test("sfsh models probe exits non-zero with 'report to PM' when no luna responds (no --write)", async () => {
  const { modelsProbe } = await import("../src/commands/models.ts");
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = () => {};
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await modelsProbe({ write: false, json: false, ports: ["luna"] }, fakeFactory(new Set(), []));
    assert.notEqual(code, 0);
    assert.match(err.join("\n"), /report to PM/);
  } finally {
    console.log = log;
    console.error = error;
  }
});
