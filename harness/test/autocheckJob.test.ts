/**
 * M3 gate (7.2 M3): S4 through the job runner. The planted work (WP-3.4) and an advisory-heavy work both run the
 * real `autocheck` stage inside runJob: every planted item is detected, only those parts are removed, and the job
 * completes (state done). Orchestrator-owned (runner wiring, CP-032).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { newJobState, runJob, STAGES, type RunnerDeps } from "../src/job/runner.ts";
import type { ModelRequest } from "../src/model/types.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";
import type { Fetcher } from "../src/research/types.ts";
import { buildAdvisoryWork, buildPlantedWork, P1_REWRITE, P2_STILL_COPIED, WORK_ID } from "./fixtures/m3/planted.ts";

const noFetcher: Fetcher = { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) };
const promptItems = (prompt: string) => [...prompt.matchAll(/^## (i\d+)（[^\n]*・(\$[^）\n]*)）$/gm)].map((m) => ({ id: m[1], path: m[2] }));

function jobAtAutocheck(worksDir: string) {
  const st = newJobState({ jobId: "20990101-0003", workQuery: "x", mediumHint: null, rangeRaw: "全体" }, new Date());
  for (const s of STAGES) if (s !== "autocheck") st.stages[s].status = "done";
  st.work_id = WORK_ID;
  return st;
}

test("runner: autocheck stage on the planted work — all planted items detected, fixed, job done", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh_s4job_"));
  const p = buildPlantedWork(root);
  const calls: FakeCall[] = [];
  const handler = (want: Record<string, string>) => (req: ModelRequest) =>
    req.task !== "s4.a1.rewrite" ? undefined : { items: promptItems(req.prompt).filter((it) => want[it.path]).map((it) => ({ id: it.id, text: want[it.path] })) };
  const deps: RunnerDeps = {
    luna: fakePort("luna", handler({ [p.a1Paths.P2]: P2_STILL_COPIED }), calls),
    haiku: fakePort("haiku", handler({ [p.a1Paths.P1]: P1_REWRITE }), calls),
    fetcher: noFetcher,
    worksDir: root,
    jobsDir: path.join(root, "jobs"),
  };
  const out = await runJob(jobAtAutocheck(root), deps);
  assert.equal(out.state, "done", out.error ?? "");
  const m = out.stages.autocheck.metrics;
  assert.equal(m.a1_detected, Object.keys(p.a1Paths).length);
  assert.equal(m.a2_detected, p.a2.length);
  assert.equal(m.residual, 0);
  const report = JSON.parse(fs.readFileSync(path.join(p.dir, "check", "report.json"), "utf8"));
  assert.equal(report.blocking, false);
  assert.deepEqual(report.a1.detected.map((d: { path: string }) => d.path).sort(), Object.values(p.a1Paths).sort());
  assert.equal(report.a1.residual_after_fix, 0);
  assert.equal(report.a2.residual_after_fix, 0);
  const log = fs.readFileSync(path.join(root, "jobs", "20990101-0003.log"), "utf8");
  assert.match(log, /stage autocheck done/);
  assert.match(log, /run end state=done/);
  assert.match(log, /notice: 自動確認: A-1 検出 6・A-2 検出 5/, "completion notice carries the S4 summary (5.2)");
});

test("runner: advisory-heavy work (300 quotes, 250 guideline warnings, provisional title, …) — job done, nothing blocked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh_s4adv_"));
  const a = buildAdvisoryWork(root);
  const before = fs.readFileSync(path.join(a.dir, "gen", "public.json"), "utf8");
  const deps: RunnerDeps = { luna: fakePort("luna", () => undefined), haiku: fakePort("haiku", () => undefined), fetcher: noFetcher, worksDir: root, jobsDir: path.join(root, "jobs") };
  const out = await runJob(jobAtAutocheck(root), deps);
  assert.equal(out.state, "done", out.error ?? "");
  const report = JSON.parse(fs.readFileSync(path.join(a.dir, "check", "report.json"), "utf8"));
  assert.equal(report.blocking, false);
  assert.ok(report.advisory.length >= a.quotes + a.warnings, `advisory count ${report.advisory.length}`);
  assert.ok(report.advisory_counts.title_provisional >= 1, "provisional title is an advisory (7.4 M3)");
  assert.equal(fs.readFileSync(path.join(a.dir, "gen", "public.json"), "utf8"), before, "advisories never change or withhold the public file");
});
