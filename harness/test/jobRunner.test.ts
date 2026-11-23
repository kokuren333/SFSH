import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { newJobState, parseRangeLite, runJob, STAGES, type JobState, type RunnerDeps, type StageName } from "../src/job/runner.ts";
import type { StageContext, StageResult } from "../src/job/context.ts";
import type { ModelPort } from "../src/model/types.ts";
import { fixtureMeta, fixtureNkg } from "../src/nkg/testFixtures.ts";
import type { Fetcher } from "../src/research/types.ts";

const noPort = (port: "luna" | "haiku"): ModelPort => ({
  port,
  modelId: "none",
  call: async () => {
    throw new Error("no model calls expected");
  },
});
const noFetcher: Fetcher = { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) };
const ok = async (): Promise<StageResult> => ({ outputs: [], metrics: {}, warnings: [] });

function setup(): { st: JobState; deps: RunnerDeps; workDir: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh_runner_"));
  const worksDir = path.join(root, "works");
  const jobsDir = path.join(root, "jobs");
  const st = newJobState({ jobId: "20990101-0001", workQuery: "x", mediumHint: null, rangeRaw: "全体" }, new Date());
  // identify is not overridable: mark it done and pretend it resolved.
  st.stages.identify.status = "done";
  st.work_id = "novel-test-2000";
  const workDir = path.join(worksDir, st.work_id);
  fs.mkdirSync(path.join(workDir, "research"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "nkg"), { recursive: true });
  for (const f of ["sources", "claims", "search_log", "fetch_log", "gaps"]) fs.writeFileSync(path.join(workDir, "research", `${f}.json`), "[]");
  fs.writeFileSync(path.join(workDir, "research", "candidates.json"), JSON.stringify({ selected: [], rejected: [] }));
  const overrides: Partial<Record<StageName, (ctx: StageContext) => Promise<StageResult>>> = {};
  for (const s of STAGES) if (s !== "identify" && s !== "check") overrides[s] = ok;
  const deps: RunnerDeps = { luna: noPort("luna"), haiku: noPort("haiku"), fetcher: noFetcher, worksDir, jobsDir, stageOverrides: overrides };
  return { st, deps, workDir, root };
}

function writeNkgWithSoftLimitOverruns(workDir: string): void {
  const n = fixtureNkg();
  for (let i = 3; i <= 72; i++) {
    n.nodes.push({
      id: `ev${String(i).padStart(2, "0")}`,
      type: "Event",
      module: "M03",
      label: "とても長いラベル".repeat(8),
      summary: "あ".repeat(200),
      story_order: i,
      disclosure_phase: null,
      based_on: [],
      meta: fixtureMeta(["s000000001"]),
    } as never);
  }
  fs.writeFileSync(path.join(workDir, "nkg", "nkg.json"), JSON.stringify(n));
}

test("job level: soft-limit overruns (72 Events, long labels) are warnings and the job still completes", async () => {
  const { st, deps, workDir } = setup();
  deps.stageOverrides!.assemble = async () => (writeNkgWithSoftLimitOverruns(workDir), ok());
  const out = await runJob(st, deps);
  assert.equal(out.state, "done", out.error ?? "");
  assert.equal(out.stages.check.status, "done");
  assert.equal(out.stages.check.metrics.nkg_valid, 1);
  assert.ok(Number(out.stages.check.metrics.nkg_warnings) > 0, "warnings were produced");
  const v = JSON.parse(fs.readFileSync(path.join(workDir, "nkg", "validation.json"), "utf8"));
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w: string) => /Event count 72 > 60/.test(w)));
});

test("job level: a broken NKG (schema error) fails the check stage after 3 attempts", async () => {
  const { st, deps, workDir } = setup();
  deps.stageOverrides!.assemble = async () => {
    const n = fixtureNkg() as any;
    n.nodes.push({ id: "sc01", type: "Scene", module: "M03", label: "x", based_on: [], meta: fixtureMeta(["s000000001"]) });
    fs.writeFileSync(path.join(workDir, "nkg", "nkg.json"), JSON.stringify(n));
    return ok();
  };
  const out = await runJob(st, deps);
  assert.equal(out.state, "failed");
  assert.equal(out.stages.check.attempts, 3);
  assert.match(out.error ?? "", /NKG validation failed/);
});

test("runner: a stage failing once is retried and the job completes (4.4: up to 2 retries)", async () => {
  const { st, deps, workDir } = setup();
  let n = 0;
  deps.stageOverrides!.search_r1 = async () => {
    n++;
    if (n === 1) throw new Error("transient");
    return ok();
  };
  deps.stageOverrides!.assemble = async () => (fs.writeFileSync(path.join(workDir, "nkg", "nkg.json"), JSON.stringify(fixtureNkg())), ok());
  const out = await runJob(st, deps);
  assert.equal(out.state, "done", out.error ?? "");
  assert.equal(out.stages.search_r1.attempts, 2);
  const log = fs.readFileSync(path.join(deps.jobsDir, `${st.job_id}.log`), "utf8");
  assert.match(log, /stage search_r1 error: transient/);
});

test("runner: a stage failing 3 times → job failed, later stages untouched; state persisted for resume", async () => {
  const { st, deps } = setup();
  deps.stageOverrides!.claims_r1 = async () => {
    throw new Error("always");
  };
  const out = await runJob(st, deps);
  assert.equal(out.state, "failed");
  assert.equal(out.stages.claims_r1.attempts, 3);
  assert.equal(out.stages.review_r1.status, "pending");
  const saved = JSON.parse(fs.readFileSync(path.join(deps.jobsDir, `${st.job_id}.state.json`), "utf8"));
  assert.equal(saved.state, "failed");
  assert.equal(saved.stages.search_r1.status, "done");
});

test("runner: --until stops after the named stage; done stages are skipped on the next run", async () => {
  const { st, deps, workDir } = setup();
  const calls: string[] = [];
  for (const s of ["search_r1", "claims_r1", "review_r1"] as const) deps.stageOverrides![s] = async () => (calls.push(s), ok());
  const a = await runJob(st, { ...deps, until: "claims_r1" });
  assert.deepEqual(calls, ["search_r1", "claims_r1"]);
  assert.equal(a.stages.review_r1.status, "pending");
  deps.stageOverrides!.assemble = async () => (fs.writeFileSync(path.join(workDir, "nkg", "nkg.json"), JSON.stringify(fixtureNkg())), ok());
  const b = await runJob(a, deps);
  assert.equal(b.state, "done", b.error ?? "");
  assert.deepEqual(calls, ["search_r1", "claims_r1", "review_r1"], "done stages are not re-run");
});

test("parseRangeLite: M1 subset of the range grammar", () => {
  assert.deepEqual(parseRangeLite("全体"), [{ unit: "whole", from: null, to: null, label: "全体" }]);
  assert.deepEqual(parseRangeLite("全12話"), [{ unit: "episode", from: 1, to: 12, label: "全12話" }]);
  assert.deepEqual(parseRangeLite("1-3巻"), [{ unit: "volume", from: 1, to: 3, label: "1-3巻" }]);
  assert.equal(parseRangeLite("「なにか」編")[0].label, "「なにか」編");
});

// ---- M3 WP-3.3: hold stops an in-progress job at the next stage boundary (5.4); 4.4 new jobs on a Restricted work proceed
function writeWorkJson(workDir: string, mode: "Public" | "Restricted", history: { at: string; event: string }[]): void {
  fs.writeFileSync(path.join(workDir, "work.json"), JSON.stringify({ work_id: "novel-test-2000", title: "t", publish_mode: mode, history }));
}

test("job level: a hold recorded after the job was received stops the job in state held before the next stage; release + resume continues", async () => {
  const { st, deps, workDir } = setup();
  const later = new Date(Date.parse(st.request.received_at) + 1000).toISOString();
  let ran = 0;
  deps.stageOverrides!.search_r1 = async () => (ran++, writeWorkJson(workDir, "Restricted", [{ at: later, event: "hold" }]), ok());
  const out = await runJob(st, deps);
  assert.equal(out.state, "held");
  assert.equal(out.stages.search_r1.status, "done");
  assert.equal(out.stages.claims_r1.status, "pending", "no stage ran after the hold");
  assert.equal(ran, 1);
  const log = fs.readFileSync(path.join(deps.jobsDir, `${st.job_id}.log`), "utf8");
  assert.match(log, /held before stage claims_r1/);
  // resume while still Restricted → held again, nothing runs
  const again = await runJob(out, deps);
  assert.equal(again.state, "held");
  assert.equal(again.stages.claims_r1.status, "pending");
  // release (Public) → resume runs to the end
  writeWorkJson(workDir, "Public", [{ at: later, event: "hold" }, { at: later, event: "release" }]);
  deps.stageOverrides!.assemble = async () => (writeNkgWithSoftLimitOverruns(workDir), ok());
  const done = await runJob(again, deps);
  assert.equal(done.state, "done", done.error ?? "");
});

test("job level: a job received after the work was already Restricted proceeds (4.4: accepted, not published)", async () => {
  const { st, deps, workDir } = setup();
  const earlier = new Date(Date.parse(st.request.received_at) - 60_000).toISOString();
  writeWorkJson(workDir, "Restricted", [{ at: earlier, event: "hold" }]);
  deps.stageOverrides!.assemble = async () => (writeNkgWithSoftLimitOverruns(workDir), ok());
  const out = await runJob(st, deps);
  assert.equal(out.state, "done", out.error ?? "");
});
