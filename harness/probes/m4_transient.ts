/**
 * CP-035 d: frequency of transient model-CLI failures. Reads every call log (logs/calls/*.jsonl and the M3 repro
 * copies, plus any extra files given as args) and counts calls / failures per port and failure kind.
 * "Transient" = an `exit` failure (CLI exited non-zero without a usable answer), as opposed to deterministic
 * failures (model_not_found from the probe, schema errors, timeouts are listed separately).
 * Usage: node harness/probes/m4_transient.ts [extra.jsonl ...]  → JSON on stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../src/paths.ts";

const files = [
  ...fs.readdirSync(paths.callLogDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(paths.callLogDir, f)),
  ...["run1", "run2"].map((r) => path.join(paths.root, "logs", "m3", "repro", r, "calls.jsonl")).filter((f) => fs.existsSync(f)),
  ...process.argv.slice(2),
];

type Row = { ts: string; task: string; port: string; ok: boolean; error: string | null; jobId?: string | null; durationMs?: number };
const out: Record<string, unknown> = { files: files.map((f) => path.relative(paths.root, f)) };
const perPort: Record<string, { calls: number; ok: number; failures: Record<string, number>; transient: { ts: string; task: string; job: string | null; error: string }[] }> = {};
const seen = new Set<string>();
let duplicates = 0;
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r: Row;
    try {
      r = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    const k = `${r.ts}|${r.task}|${r.port}|${r.durationMs}|${r.ok}`;
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    const p = (perPort[r.port] ??= { calls: 0, ok: 0, failures: {}, transient: [] });
    p.calls++;
    if (r.ok) {
      p.ok++;
      continue;
    }
    const kind = String(r.error ?? "unknown").split(":")[0]!.trim();
    p.failures[kind] = (p.failures[kind] ?? 0) + 1;
    if (kind === "exit") p.transient.push({ ts: r.ts, task: r.task, job: r.jobId ?? null, error: String(r.error).slice(0, 160) });
  }
}
out.duplicates_skipped = duplicates;
out.per_port = perPort;
out.summary = Object.fromEntries(
  Object.entries(perPort).map(([port, p]) => [port, { calls: p.calls, transient_exit: p.transient.length, rate: p.calls ? Number((p.transient.length / p.calls).toFixed(4)) : 0 }]),
);
console.log(JSON.stringify(out, null, 2));
