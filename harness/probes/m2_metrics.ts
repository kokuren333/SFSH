/**
 * M2 measurement (CP-022 observation c, U-13 / 7.3): per-stage wall time and model cost of one job.
 * Usage: node harness/probes/m2_metrics.ts <job_id> [--out logs/m2/metrics_<job_id>.json]
 *
 * Calls are attributed to the stage whose [started_at, finished_at] window (last attempt) contains the call's
 * log timestamp. Haiku cost = CLI-reported costUsd (list-price equivalent; the subscription CLI does not bill).
 * Luna cost is not reported by the CLI: estimated from tokens at an ASSUMED $0.10 / $0.50 per MTok
 * (input / output; CP-010, third-party figure, unverified) — shown separately and labelled as an estimate.
 */
import fs from "node:fs";
import path from "node:path";

const LUNA_IN_PER_MTOK = 0.1;
const LUNA_OUT_PER_MTOK = 0.5;

interface CallLine {
  ts: string;
  task: string;
  jobId: string | null;
  port: "haiku" | "luna";
  durationMs: number;
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  costUsd: number | null;
  ok: boolean;
  webSearches?: number;
}

const root = path.resolve(import.meta.dirname, "..", "..");
const jobId = process.argv[2];
if (!jobId) {
  console.error("usage: node harness/probes/m2_metrics.ts <job_id> [--out file]");
  process.exit(2);
}
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1]! : path.join(root, "logs", "m2", `metrics_${jobId}.json`);

const st = JSON.parse(fs.readFileSync(path.join(root, "logs", "jobs", `${jobId}.state.json`), "utf8"));
const callDir = path.join(root, "logs", "calls");
const calls: CallLine[] = [];
for (const f of fs.readdirSync(callDir).sort()) {
  if (!f.endsWith(".jsonl")) continue;
  for (const line of fs.readFileSync(path.join(callDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as CallLine;
    if (c.jobId === jobId) calls.push(c);
  }
}

const t = (s: string | null) => (s ? Date.parse(s) : NaN);
interface Row {
  stage: string;
  status: string;
  attempts: number;
  seconds: number | null;
  calls_haiku: number;
  calls_luna: number;
  calls_failed: number;
  haiku_model_seconds: number;
  luna_model_seconds: number;
  haiku_cost_usd: number;
  haiku_out_tokens: number;
  luna_in_tokens: number;
  luna_out_tokens: number;
  luna_cost_usd_est: number;
  web_searches: number;
}
const rows: Row[] = [];
const assigned = new Set<CallLine>();
// Each call goes to the stage with the latest started_at ≤ call ts (second precision), if the call is not after
// that stage's finished_at (+1 s). Calls of earlier, overwritten attempts/runs stay unassigned (reported).
const windows = (Object.entries(st.stages) as [string, any][])
  .map(([name, rec]) => ({ name, a: Math.floor(t(rec.started_at) / 1000) * 1000, b: t(rec.finished_at) }))
  .filter((w) => Number.isFinite(w.a) && Number.isFinite(w.b));
const owner = new Map<CallLine, string>();
for (const c of calls) {
  const ts = t(c.ts);
  // among stages whose window contains the call, the latest start wins; same-second starts → the later end wins
  const cand = windows.filter((w) => w.a <= ts && ts <= w.b + 1000).sort((x, y) => y.a - x.a || y.b - x.b)[0];
  if (cand) owner.set(c, cand.name);
}
for (const [name, rec] of Object.entries(st.stages) as [string, any][]) {
  const mine = calls.filter((c) => owner.get(c) === name);
  for (const c of mine) assigned.add(c);
  const H = mine.filter((c) => c.port === "haiku");
  const Lc = mine.filter((c) => c.port === "luna");
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
  const lin = sum(Lc.map((c) => (c.tokens.input ?? 0) + (c.tokens.cacheRead ?? 0)));
  const lout = sum(Lc.map((c) => c.tokens.output ?? 0));
  rows.push({
    stage: name,
    status: rec.status,
    attempts: rec.attempts,
    seconds: rec.duration_ms != null ? Math.round(rec.duration_ms / 100) / 10 : null,
    calls_haiku: H.length,
    calls_luna: Lc.length,
    calls_failed: mine.filter((c) => !c.ok).length,
    haiku_model_seconds: Math.round(sum(H.map((c) => c.durationMs)) / 100) / 10,
    luna_model_seconds: Math.round(sum(Lc.map((c) => c.durationMs)) / 100) / 10,
    haiku_cost_usd: Math.round(sum(H.map((c) => c.costUsd ?? 0)) * 10000) / 10000,
    haiku_out_tokens: sum(H.map((c) => c.tokens.output ?? 0)),
    luna_in_tokens: lin,
    luna_out_tokens: lout,
    luna_cost_usd_est: Math.round(((lin * LUNA_IN_PER_MTOK + lout * LUNA_OUT_PER_MTOK) / 1e6) * 10000) / 10000,
    web_searches: sum(Lc.map((c) => c.webSearches ?? 0)),
  });
}
const total = (k: keyof Row) => Math.round(rows.reduce((n, r) => n + (Number(r[k]) || 0), 0) * 10000) / 10000;
const stageTimes = Object.values(st.stages) as any[];
const first = Math.min(...stageTimes.map((r) => t(r.started_at)).filter(Number.isFinite));
const last = Math.max(...stageTimes.map((r) => t(r.finished_at)).filter(Number.isFinite));
const summary = {
  job_id: jobId,
  work_id: st.work_id,
  state: st.state,
  first_stage_start: new Date(first).toISOString(),
  last_stage_end: new Date(last).toISOString(),
  wall_seconds_first_to_last: Math.round((last - first) / 1000),
  sum_stage_seconds: total("seconds"),
  calls_total: calls.length,
  calls_unassigned: calls.length - assigned.size,
  calls_failed: calls.filter((c) => !c.ok).length,
  haiku_cost_usd: total("haiku_cost_usd"),
  luna_cost_usd_est: total("luna_cost_usd_est"),
  luna_price_assumption: `$${LUNA_IN_PER_MTOK}/$${LUNA_OUT_PER_MTOK} per MTok (unverified, CP-010)`,
  budget: st.budget,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ summary, stages: rows }, null, 2) + "\n", "utf8");

const pad = (s: unknown, w: number) => String(s).padEnd(w);
console.log(`job ${jobId} (${st.work_id}) state=${st.state} wall=${summary.wall_seconds_first_to_last}s calls=${calls.length} (failed ${summary.calls_failed}, unassigned ${summary.calls_unassigned})`);
console.log(`${pad("stage", 12)}${pad("sec", 8)}${pad("att", 4)}${pad("H", 4)}${pad("L", 4)}${pad("H$", 9)}${pad("Hout", 8)}${pad("Lin", 10)}${pad("Lout", 8)}${pad("L$est", 8)}srch`);
for (const r of rows)
  console.log(`${pad(r.stage, 12)}${pad(r.seconds ?? "-", 8)}${pad(r.attempts, 4)}${pad(r.calls_haiku, 4)}${pad(r.calls_luna, 4)}${pad(r.haiku_cost_usd, 9)}${pad(r.haiku_out_tokens, 8)}${pad(r.luna_in_tokens, 10)}${pad(r.luna_out_tokens, 8)}${pad(r.luna_cost_usd_est, 8)}${r.web_searches}`);
console.log(`total: haiku $${summary.haiku_cost_usd} (CLI-reported) / luna $${summary.luna_cost_usd_est} (estimate) → ${out}`);
