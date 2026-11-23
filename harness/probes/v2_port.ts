// V-2 re-run through the harness ModelPort (WP-0.2): same prompt/schema as v2_run.py.
// usage: npx tsx harness/probes/v2_port.ts <haiku|luna> <N> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModelPort } from "../src/model/index.ts";
const [which, nStr, outdir] = process.argv.slice(2) as ["haiku" | "luna", string, string];
const n = Number(nStr);
mkdirSync(outdir, { recursive: true });
const schema = JSON.parse(readFileSync("harness/probes/v2_schema.json", "utf8"));
const prompt = readFileSync("harness/probes/v2_prompt.txt", "utf8");
const port = getModelPort(which);
const results: unknown[] = [];
for (let i = 1; i <= n; i++) {
  try {
    const r = await port.call({ task: "m0.v2", prompt, schema, timeoutMs: 240000 });
    results.push({ i, ok: true, modelId: r.modelId, ms: r.durationMs });
  } catch (e) {
    results.push({ i, ok: false, err: String(e).slice(0, 300) });
  }
  writeFileSync(join(outdir, `status_${which}.json`), JSON.stringify({ which, done: i, of: n, results }, null, 1));
  const last = results[results.length - 1] as { ok: boolean };
  console.log(JSON.stringify(last));
  if (!last.ok) break;
}
const ok = (results as { ok: boolean }[]).filter((r) => r.ok).length;
console.log(`SUMMARY ${which}: ${ok}/${n} consecutive ok via ModelPort`);
