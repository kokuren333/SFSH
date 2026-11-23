import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.ts";

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("help / no args list all commands", async () => {
  for (const argv of [[], ["help"]]) {
    const r = await run(argv);
    assert.equal(r.code, 0);
    for (const c of ["enqueue", "import", "status", "cancel", "hold", "release", "takedown", "purge", "publish", "preview", "models probe"]) {
      assert.ok(r.out.includes(c), `help should mention ${c}`);
    }
  }
});

test("no stubs remain; publish is never run against the real repository from tests", async () => {
  // M4 commands (enqueue/import/status/cancel/answer/worker/discord) and M5 publish are implemented and tested against
  // temp dirs (queue*/batch*/discord*/publish*/m5Gate tests) — never run them here (they would write into the real repo).
  const help = await run(["help"]);
  assert.ok(!help.out.includes("[stub:"), "no command is a stub any more");
  // Under the test runner the default-env publish refuses before doing anything (no build, no record, no ledger line).
  for (const argv of [["publish"], ["publish", "--dry-run"], ["publish", "status"], ["publish", "init"]]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /refusing to run against the real repository under the test runner/);
  }
});

test("owner ops (M3) are implemented: an unknown work_id exits 2 without touching anything", async () => {
  for (const c of ["hold", "release", "takedown", "purge"]) {
    const r = await run([c, "novel-does-not-exist-1900"]);
    assert.equal(r.code, 2, c);
  }
});

test("unknown command and missing required args → non-zero", async () => {
  assert.notEqual((await run(["frobnicate"])).code, 0);
  assert.notEqual((await run(["hold"])).code, 0);
  assert.notEqual((await run(["import"])).code, 0);
  assert.notEqual((await run(["models"])).code, 0);
  assert.notEqual((await run(["models", "probe", "--bogus"])).code, 0);
  assert.notEqual((await run(["constructor"])).code, 0);
});
