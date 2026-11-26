/**
 * WP-4.1〜4.3 queue worker: state flow with directory moves, ordering (priority, intake before main), clarifying +
 * answers (range / pick an existing work / pick a research candidate without a new search), idempotent merge
 * (same key, into a legacy done job, into a built job; different range does not merge), retries → failed, cancel
 * (queued / running at a boundary / permission), Restricted notice, notices at most once across a restart.
 * Temp dirs only, fake ports, stage overrides, injected build.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { answerCommand, cancelCommand, enqueueCommand, statusCommand } from "../src/commands/queue.ts";
import { readState, STAGES } from "../src/job/runner.ts";
import type { ModelPort, ModelRequest, ModelResult, WebSearchEvent } from "../src/model/types.ts";
import { listNotices } from "../src/queue/notify.ts";
import { answerJob, cancelJob } from "../src/queue/ops.ts";
import { submitJob } from "../src/queue/request.ts";
import { jobStatus, queueSummary } from "../src/queue/status.ts";
import { findJob, type QueueEnv } from "../src/queue/store.ts";
import type { Actor, JobInput, JobRequest } from "../src/queue/types.ts";
import { runWorker, type WorkerDeps } from "../src/queue/worker.ts";
import type { Candidate, FetchBatchResult, FetchContext, FetchDecision, Fetcher, SourceCard } from "../src/research/types.ts";
import { sha256Hex } from "../src/util/hash.ts";
import { makeEnv, noFetcher, noPort, okOverrides, okStage, seedWork } from "./e2e/workerChild.ts";

const OWNER: Actor = { id: "local", name: "owner", origin: "cli", is_owner: true };
const T0 = Date.parse("2026-11-23T09:00:00+09:00");
const at = (s: number) => new Date(T0 + s * 1000);

function setup(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-qworker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = makeEnv(root);
  const builds: string[] = [];
  const transitions: { id: string; state: string }[] = [];
  const luna = noPort("luna");
  const deps: WorkerDeps = {
    luna,
    haiku: noPort("haiku"),
    fetcher: noFetcher,
    stageOverrides: okOverrides(),
    build: async (o) => {
      builds.push(o.out);
      return { works: 1 };
    },
    afterTransition: (j) => transitions.push({ id: j.job_id, state: j.state }),
  };
  return { root, env, deps, builds, transitions, luna };
}

function submit(env: QueueEnv, input: Partial<JobInput> & { work: string }, s = 0): JobRequest {
  const r = submitJob(env, { origin: "cli", ...input }, at(s));
  assert.ok(r.ok, r.errors.join("; "));
  return r.job!;
}

const job = (env: QueueEnv, id: string) => findJob(env, id)!;
const jobLog = (env: QueueEnv, id: string) => fs.readFileSync(path.join(env.jobsDir, `${id}.log`), "utf8");
/** Notice kinds of a job, sorted (submit uses a fixed clock, the worker the real one: `at` order is not meaningful here). */
const kinds = (env: QueueEnv, id: string) => listNotices(env, { job_id: id }).map((n) => n.kind).sort();

const W1 = { work_id: "novel-hoshifuru-toudai-2001", title: "星降る灯台", medium: "novel", title_reading: "ほしふる とうだい" };

// ------------------------------------------------------------------ state flow

test("worker: received → identifying → queued → researching → structuring → generating → checking → building → built, with directory moves and log lines", async (t) => {
  const { env, deps, builds, transitions } = setup(t);
  seedWork(env, W1);
  const j = submit(env, { work: "星降る灯台", range: "全体" });
  const seen: Record<string, string> = {};
  const probe = (stage: string) => async () => {
    const l = job(env, j.job_id);
    seen[stage] = `${l.dir}/${l.job.state}`;
    return okStage();
  };
  deps.stageOverrides!.search_r1 = probe("search_r1");
  deps.stageOverrides!.modules = probe("modules");
  deps.stageOverrides!.tags = probe("tags");
  deps.stageOverrides!.autocheck = probe("autocheck");
  const s = await runWorker(env, deps, { once: true });
  assert.deepEqual(s.processed, [{ job_id: j.job_id, state: "built" }]);
  assert.deepEqual(seen, { search_r1: "running/researching", modules: "running/structuring", tags: "running/generating", autocheck: "running/checking" });
  const states = transitions.filter((x) => x.id === j.job_id).map((x) => x.state);
  const order = ["identifying", "queued", "researching", "structuring", "generating", "checking", "building", "built"];
  assert.deepEqual(states.filter((x, i) => x !== states[i - 1]), order);
  const loc = job(env, j.job_id);
  assert.equal(loc.dir, "done");
  assert.equal(loc.job.resolved!.work_id, W1.work_id);
  assert.equal(loc.job.idempotency_key, `${W1.work_id}|whole|1.0`);
  assert.equal(builds.length, 1);
  const log = jobLog(env, j.job_id);
  assert.match(log, /state received -> identifying \(inbox\/ -> inbox\/\)/);
  assert.match(log, /state identifying -> queued \(inbox\/ -> ready\/\)/);
  assert.match(log, /state queued -> researching \(ready\/ -> running\/\)/);
  assert.match(log, /state building -> built \(running\/ -> done\/\)/);
  assert.match(log, /stage autocheck done/);
  // local notices (reply_to null) are logged and moved to sent via "local"
  const ns = listNotices(env, { job_id: j.job_id }).sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(ns.map((n) => n.kind), ["completed", "received"]);
  assert.ok(ns.every((n) => n.sent_via === "local"));
  assert.match(log, new RegExp(`notice ${j.job_id}\\.completed \\[completed\\]`));
  assert.match(ns[0].text, /ローカルプレビュー/);
  // status views
  const st = jobStatus(env, j.job_id);
  assert.equal(st.ok, true);
  assert.match(st.text, /state=built/);
  assert.equal((st.data.stages as unknown[]).length, STAGES.length); // 19 since AMENDMENT 12 (search_plot, gapfill, refact)
  assert.equal((queueSummary(env).data.counts as Record<string, number>).built, 1);
  // worker lock released
  assert.ok(!fs.existsSync(path.join(env.queueDir, "worker.lock")));
});

test("worker: priority high first, then received order; every received job is identified before any main processing", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, { work_id: "novel-a-2001", title: "作品A", medium: "novel" });
  seedWork(env, { work_id: "novel-b-2001", title: "作品B", medium: "novel" });
  seedWork(env, { work_id: "novel-c-2001", title: "作品C", medium: "novel" });
  const a = submit(env, { work: "作品A" }, 0);
  const b = submit(env, { work: "作品B" }, 1);
  const c = submit(env, { work: "作品C", priority: "high" }, 2);
  const order: string[] = [];
  let snapshot: string[] | null = null;
  deps.stageOverrides!.search_r1 = async (ctx) => {
    order.push(ctx.jobId);
    snapshot ??= [a, b, c].map((x) => job(env, x.job_id).job.state);
    return okStage();
  };
  await runWorker(env, deps, { once: true });
  assert.deepEqual(order, [c.job_id, a.job_id, b.job_id]);
  // when the first main stage ran, the other two were already identified (queued), not received/identifying
  assert.deepEqual(snapshot, ["queued", "queued", "researching"]);
  for (const x of [a, b, c]) assert.equal(job(env, x.job_id).job.state, "built");
});

test("M6 boundary intake: a request received while a job runs is identified (and merged) at the next stage boundary, not after the job", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, W1);
  seedWork(env, { work_id: "novel-b-2001", title: "作品B", medium: "novel" });
  const a = submit(env, { work: "星降る灯台" }, 0);
  let late: JobRequest | null = null;
  let other: JobRequest | null = null;
  let seenAtTags: string[] | null = null;
  deps.stageOverrides!.fact = async (ctx) => {
    if (ctx.jobId !== a.job_id) return okStage();
    // arrives while job A is in its fact stage
    late = submit(env, { work: "星降る灯台" }, 5);
    other = submit(env, { work: "作品B" }, 6);
    return okStage();
  };
  deps.stageOverrides!.tags = async (ctx) => {
    if (ctx.jobId !== a.job_id) return okStage();
    seenAtTags = [late!, other!].map((x) => job(env, x.job_id).job.state);
    return okStage();
  };
  await runWorker(env, deps, { once: true });
  // at A's tags stage (later than the boundary after fact) both were already identified: same key → merged into
  // the running A; another work → queued (runs after A)
  assert.deepEqual(seenAtTags, ["merged", "queued"]);
  assert.equal(job(env, late!.job_id).job.merged_into, a.job_id);
  assert.equal(job(env, a.job_id).job.state, "built");
  assert.equal(job(env, other!.job_id).job.state, "built");
  assert.match(jobLog(env, late!.job_id), /identified: novel-hoshifuru-toudai-2001/);
});

// ------------------------------------------------------------------ clarifying + answers

test("clarifying: an unparsable range asks back without running identify; a range answer continues to built", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, W1);
  const j = submit(env, { work: "星降る灯台", range: "そのへん" });
  await runWorker(env, deps, { once: true });
  const c = job(env, j.job_id);
  assert.equal(c.dir, "inbox");
  assert.equal(c.job.state, "clarifying");
  assert.equal(c.job.clarify!.reason, "range_unparsed");
  assert.ok(!fs.existsSync(path.join(env.jobsDir, `${j.job_id}.state.json`)), "identify was not run");
  assert.deepEqual(kinds(env, j.job_id), ["clarifying", "received"]);
  // still bad → stays clarifying
  const bad = answerJob(env, j.job_id, { range: "3-1巻" }, OWNER);
  assert.equal(bad.ok, false);
  assert.equal(job(env, j.job_id).job.state, "clarifying");
  // a non-owner other user may not answer
  assert.equal(answerJob(env, j.job_id, { range: "1-3巻" }, { id: "99", name: "x", origin: "discord", is_owner: false }).ok, false);
  const ok = answerJob(env, j.job_id, { range: "1-3巻" }, OWNER);
  assert.equal(ok.ok, true, ok.text);
  assert.equal(job(env, j.job_id).job.state, "received");
  await runWorker(env, deps, { once: true });
  const done = job(env, j.job_id).job;
  assert.equal(done.state, "built");
  assert.equal(done.range_raw, "そのへん", "range_raw (input) kept");
  assert.deepEqual(done.range, [{ unit: "volume", from: 1, to: 3, label: "1-3巻" }]);
  assert.equal(done.idempotency_key, `${W1.work_id}|volume:1-3|1.0`);
  assert.equal(done.answers.length, 2);
  assert.equal(done.work_query, "星降る灯台");
});

test("clarifying: several INDEX matches → candidates numbered 1..n; pick an existing work continues to built (no model call)", async (t) => {
  const { env, deps, luna } = setup(t);
  seedWork(env, { work_id: "novel-toki-o-kakeru-shoujo-1967", title: "時をかける少女", medium: "novel", first_release_year: 1967 });
  seedWork(env, { work_id: "film-toki-o-kakeru-shoujo-2006", title: "時をかける少女", medium: "film", first_release_year: 2006 });
  const j = submit(env, { work: "時をかける少女", origin: "discord", requester: { id: "42", name: "u42" }, reply_to: "chan-1" });
  await runWorker(env, deps, { once: true });
  const c = job(env, j.job_id).job;
  assert.equal(c.state, "clarifying");
  assert.equal(c.clarify!.reason, "multiple_index_matches");
  const st = jobStatus(env, j.job_id);
  const cands = st.data.candidates as { n: number; work_id: string }[];
  assert.deepEqual(cands.map((x) => x.n), [1, 2]);
  const filmN = cands.find((x) => x.work_id.startsWith("film-"))!.n;
  const clar = listNotices(env, { job_id: j.job_id }).find((n) => n.kind === "clarifying")!;
  assert.equal(clar.reply_to, "chan-1");
  assert.match(clar.text, /1\. 時をかける少女/);
  assert.match(clar.text, /\/sfsh answer/);
  assert.equal(answerJob(env, j.job_id, { pick: 3 }, OWNER).ok, false, "pick out of range");
  const r = answerJob(env, j.job_id, { pick: filmN }, { id: "42", name: "u42", origin: "discord", is_owner: false });
  assert.equal(r.ok, true, r.text);
  await runWorker(env, deps, { once: true });
  const done = job(env, j.job_id).job;
  assert.equal(done.state, "built");
  assert.equal(done.resolved!.work_id, "film-toki-o-kakeru-shoujo-2006");
  assert.equal(done.clarify, null);
  assert.equal(luna.calls, 0);
});

// fake research path (s0.identify.search / extract) for the research-candidate pick
const sidOf = (url: string) => "s" + sha256Hex(url).slice(0, 10);
const U_N = "https://bunko.example/toki";
const U_F = "https://film.example/toki";
const PAGES: Record<string, string> = {
  [U_N]: "筒井康隆『時をかける少女』（ときをかけるしょうじょ）1967年刊行。",
  [U_F]: "アニメーション映画『時をかける少女』2006年公開。監督：細田守",
};
class PageFetcher implements Fetcher {
  requested: string[] = [];
  async fetchAll(candidates: Candidate[], ctx: FetchContext): Promise<FetchBatchResult> {
    const cards: SourceCard[] = [];
    const decisions: FetchDecision[] = [];
    const now = "2026-11-23T10:00:00+09:00";
    for (const c of candidates) {
      this.requested.push(c.url);
      ctx.budget.fetchesUsed++;
      const text = PAGES[c.url];
      const sid = sidOf(c.url);
      const rel = `research/raw/${sid}.txt`;
      fs.mkdirSync(path.join(ctx.workDir, "research", "raw"), { recursive: true });
      fs.writeFileSync(path.join(ctx.workDir, rel), text, "utf8");
      const host = new URL(c.url).hostname;
      cards.push({
        source_id: sid, url: c.url, final_url: c.url, title: host, publisher: host, domain: host, site_key: host, tier: "T1", tier_basis: "table", license: null,
        fetched_at: now, content_hash: "sha256:" + sha256Hex(text), raw_text_path: rel, text_chars: text.length, excerpts: [], origin: c.origin,
      });
      decisions.push({ url: c.url, decision: "fetched", status: 200, sourceId: sid, at: now, origin: c.origin });
    }
    return { cards, decisions, gaps: [] };
  }
}
function researchLuna(): ModelPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    port: "luna",
    modelId: "fake-luna",
    calls,
    async call(req: ModelRequest): Promise<ModelResult> {
      calls.push(req.task);
      let output: unknown;
      let webSearch: WebSearchEvent[] = [];
      if (req.task === "s0.identify.search") {
        webSearch = [{ itemId: "ws1", action: "search", query: "時かけ", url: null, results: [U_N, U_F].map((u) => ({ url: u, title: u, domain: new URL(u).hostname, snippet: "" })) }];
        output = { selections: [U_N, U_F].map((u) => ({ url: u, why: "bibliographic", tier_suggested: null })) };
      } else if (req.task === "s0.identify.extract") {
        output = {
          candidates: [
            { title: "時をかける少女", title_original: null, title_reading: "とき を かける しょうじょ", medium: "novel", kind:"fiction",kind_reason:"fixture novel",kind_evidence:[{source_id:sidOf(U_N),quote:"筒井康隆『時をかける少女』"}], creators: ["筒井康隆"], first_release_year: 1967, evidence: [{ source_id: sidOf(U_N), quote: "筒井康隆『時をかける少女』" }], aliases_seen: [] },
            { title: "時をかける少女", title_original: null, title_reading: "とき を かける しょうじょ", medium: "film", kind:"fiction",kind_reason:"fixture animation",kind_evidence:[{source_id:sidOf(U_F),quote:"アニメーション映画『時をかける少女』"}], creators: ["細田守"], first_release_year: 2006, evidence: [{ source_id: sidOf(U_F), quote: "アニメーション映画『時をかける少女』" }], aliases_seen: [] },
          ],
        };
      } else throw new Error(`unexpected luna task ${req.task}`);
      return { output, modelId: "fake-luna", reportedModelId: null, toolEvents: { webSearch, otherToolItems: 0, otherToolTypes: [] }, durationMs: 1, tokens: {} };
    },
  };
}

test("clarifying: research candidates (novel vs film) → pick resolves the chosen candidate from the staged sources without a new search", async (t) => {
  const { env, deps } = setup(t);
  const luna = researchLuna();
  const fetcher = new PageFetcher();
  deps.luna = luna;
  deps.fetcher = fetcher;
  const j = submit(env, { work: "時かけ" });
  await runWorker(env, deps, { once: true });
  const c = job(env, j.job_id).job;
  assert.equal(c.state, "clarifying");
  assert.equal(c.clarify!.reason, "multiple_candidates");
  assert.deepEqual(c.clarify!.candidates.map((x) => [x.medium, x.first_release_year, x.work_id]), [["novel", 1967, null], ["film", 2006, null]]);
  assert.deepEqual(luna.calls, ["s0.identify.search", "s0.identify.extract"]);
  assert.ok(fs.existsSync(path.join(env.worksDir, `_staging-${j.job_id}`)));
  assert.equal(answerJob(env, j.job_id, { pick: 1 }, OWNER).ok, true);
  await runWorker(env, deps, { once: true });
  const done = job(env, j.job_id).job;
  assert.equal(done.state, "built", done.error ?? "");
  assert.equal(done.resolved!.work_id, "novel-toki-o-kakeru-shoujo-1967");
  assert.equal(done.resolved!.method, "research");
  assert.equal(done.resolved!.title_status, "confirmed");
  assert.deepEqual(luna.calls, ["s0.identify.search", "s0.identify.extract"], "no extra model call after the pick");
  assert.equal(fetcher.requested.length, 2, "no extra fetch after the pick");
  assert.ok(fs.existsSync(path.join(env.worksDir, "novel-toki-o-kakeru-shoujo-1967", "work.json")));
  assert.ok(!fs.existsSync(path.join(env.worksDir, `_staging-${j.job_id}`)), "staging folded into the work");
  assert.ok(!fs.existsSync(path.join(env.worksDir, "film-toki-o-kakeru-shoujo-2006")), "the other candidate is not created");
  const st = readState(env.jobsDir, j.job_id);
  assert.equal(st.stages.identify.status, "done");
  assert.match(jobLog(env, j.job_id), /by pick 1 .*no new search/);
  // the input differs from the canonical title → identified notice (§4.6-5)
  assert.ok(kinds(env, j.job_id).includes("identified"));
});

// ------------------------------------------------------------------ merge

test("merge: same key merges into the running job (notices to both reply_to), into a built job, and into a legacy done state file; another range does not merge", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, W1);
  const a = submit(env, { work: "星降る灯台", origin: "discord", requester: { id: "42", name: "u42" }, reply_to: "chan-A" }, 0);
  const b = submit(env, { work: "星降る灯台", range: "全体", origin: "discord", requester: { id: "43", name: "u43" }, reply_to: "chan-B" }, 1);
  const c = submit(env, { work: "星降る灯台", range: "1巻" }, 2);
  await runWorker(env, deps, { once: true });
  const A = job(env, a.job_id).job;
  const B = job(env, b.job_id).job;
  assert.equal(A.state, "built");
  assert.equal(B.state, "merged");
  assert.equal(B.merged_into, a.job_id);
  assert.equal(job(env, b.job_id).dir, "done");
  assert.deepEqual(A.merged_from.map((m) => m.job_id), [b.job_id]);
  assert.equal(job(env, c.job_id).job.state, "built", "different range → its own job");
  assert.notEqual(job(env, c.job_id).job.merged_into, a.job_id);
  const all = listNotices(env);
  const byId = new Map(all.map((n) => [n.id, n]));
  assert.equal(byId.get(`${b.job_id}.merged`)!.reply_to, "chan-B");
  assert.equal(byId.get(`${a.job_id}.completed`)!.reply_to, "chan-A");
  assert.equal(byId.get(`${a.job_id}.completed.${b.job_id}`)!.reply_to, "chan-B", "merged requester gets the completion too");
  assert.equal(all.filter((n) => n.id.startsWith(`${a.job_id}.completed`)).length, 2, "one notice per target");
  assert.equal(byId.get(`${a.job_id}.completed`)!.sent_at, undefined, "discord notices stay pending for the bot");

  // into an already built job
  const d = submit(env, { work: "星降る灯台" }, 10);
  await runWorker(env, deps, { once: true });
  const D = job(env, d.job_id).job;
  assert.equal(D.state, "merged");
  assert.equal(D.merged_into, a.job_id);
  const dn = listNotices(env, { job_id: d.job_id }).find((n) => n.kind === "merged")!;
  assert.equal(dn.data.target_finished, true);
  assert.match(dn.text, /完了済み/);

  // into a legacy M1–M3 job (state file only, state done)
  const W2 = { work_id: "novel-legacy-2001", title: "旧作品", medium: "novel" };
  seedWork(env, W2);
  fs.writeFileSync(
    path.join(env.jobsDir, "20261101-0001.state.json"),
    JSON.stringify({ job_id: "20261101-0001", state: "done", work_id: W2.work_id, request: { job_id: "20261101-0001", received_at: "2026-11-01T10:00:00+09:00", range: [{ unit: "whole", from: null, to: null, label: "全体" }] }, stages: {} }),
  );
  const e = submit(env, { work: "旧作品", range: "全体" }, 20);
  await runWorker(env, deps, { once: true });
  const E = job(env, e.job_id).job;
  assert.equal(E.state, "merged");
  assert.equal(E.merged_into, "20261101-0001");
});

// ------------------------------------------------------------------ failure / cancel

test("failed: a stage failing 3 times fails the job (failed/ + notice); a build failing 3 times fails too", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, W1);
  seedWork(env, { work_id: "novel-b-2001", title: "作品B", medium: "novel" });
  const a = submit(env, { work: "星降る灯台" }, 0);
  let n = 0;
  deps.stageOverrides!.claims_r1 = async (ctx) => {
    if (ctx.jobId === a.job_id) {
      n++;
      throw new Error("always broken");
    }
    return okStage();
  };
  await runWorker(env, deps, { once: true });
  const A = job(env, a.job_id);
  assert.equal(A.dir, "failed");
  assert.equal(A.job.state, "failed");
  assert.match(A.job.error!, /claims_r1 failed after 3 attempts/);
  assert.equal(n, 3);
  assert.equal(readState(env.jobsDir, a.job_id).stages.claims_r1.attempts, 3);
  assert.ok(kinds(env, a.job_id).includes("failed"));

  const b = submit(env, { work: "作品B" }, 5);
  let builds = 0;
  deps.build = async () => {
    builds++;
    throw new Error("renderer down");
  };
  await runWorker(env, deps, { once: true });
  const B = job(env, b.job_id).job;
  assert.equal(B.state, "failed");
  assert.equal(builds, 3);
  assert.match(B.error!, /build failed after 3 attempts: renderer down/);
});

test("cancel: queued → cancelled at once; another non-owner user is refused; running → stops at the next stage boundary; terminal refused", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, W1);
  seedWork(env, { work_id: "novel-b-2001", title: "作品B", medium: "novel" });
  const a = submit(env, { work: "星降る灯台", origin: "discord", requester: { id: "42", name: "u42" }, reply_to: "chan-A" }, 0);
  await runWorker(env, deps, { maxJobs: 0 }); // intake only
  assert.equal(job(env, a.job_id).job.state, "queued");
  const before = fs.readFileSync(job(env, a.job_id).file, "utf8");
  const denied = cancelJob(env, a.job_id, { id: "99", name: "other", origin: "discord", is_owner: false });
  assert.equal(denied.ok, false);
  assert.match(denied.text, /権限/);
  assert.equal(fs.readFileSync(job(env, a.job_id).file, "utf8"), before, "nothing changed");
  const ok = cancelJob(env, a.job_id, { id: "42", name: "u42", origin: "discord", is_owner: false });
  assert.equal(ok.ok, true, ok.text);
  assert.equal(job(env, a.job_id).dir, "cancelled");
  assert.equal(listNotices(env, { job_id: a.job_id }).find((n) => n.kind === "cancelled")!.reply_to, "chan-A");

  const b = submit(env, { work: "作品B" }, 5);
  const ran: string[] = [];
  deps.stageOverrides!.search_r1 = async (ctx) => {
    ran.push("search_r1");
    const r = cancelJob(env, ctx.jobId, OWNER);
    assert.equal(r.ok, true, r.text);
    assert.equal(job(env, ctx.jobId).job.state, "researching", "running job is only marked");
    return okStage();
  };
  deps.stageOverrides!.claims_r1 = async () => (ran.push("claims_r1"), okStage());
  const s = await runWorker(env, deps, { once: true });
  assert.deepEqual(s.processed, [{ job_id: b.job_id, state: "cancelled" }]);
  assert.deepEqual(ran, ["search_r1"], "no stage after the cancel request");
  const B = job(env, b.job_id);
  assert.equal(B.dir, "cancelled");
  const st = readState(env.jobsDir, b.job_id);
  assert.equal(st.stages.search_r1.status, "done");
  assert.equal(st.stages.claims_r1.status, "pending", "runner state left resumable");
  assert.match(jobLog(env, b.job_id), /stopped before stage claims_r1: cancel requested/);
  assert.ok(kinds(env, b.job_id).includes("cancelled"));
  assert.equal(cancelJob(env, b.job_id, OWNER).ok, false, "terminal job cannot be cancelled");
});

// ------------------------------------------------------------------ Restricted / identified / batch / restart

test("Restricted work: accepted and processed, restricted notice at intake; input ≠ canonical title → identified notice", async (t) => {
  const { env, deps } = setup(t);
  seedWork(env, {
    ...W1,
    publish_mode: "Restricted",
    history: [{ at: "2026-01-01T00:00:00+09:00", event: "created", job_id: null }, { at: "2026-02-01T00:00:00+09:00", event: "hold", job_id: null }],
    aliases: [{ text: "ほしとう", kind: "common", attested: true, source_ids: [], origin_job_id: "x", first_seen: "2026-01-01T00:00:00+09:00" }],
  });
  const j = submit(env, { work: "ほしとう" });
  await runWorker(env, deps, { once: true });
  const J = job(env, j.job_id).job;
  assert.equal(J.state, "built", "processing continues (never published: M3 build excludes Restricted)");
  assert.ok(J.restricted_notice_at);
  const ns = listNotices(env, { job_id: j.job_id });
  assert.deepEqual(kinds(env, j.job_id), ["completed", "identified", "received", "restricted"]);
  assert.match(ns.find((n) => n.kind === "identified")!.text, /入力「ほしとう」→ 正式名称「星降る灯台」/);
});

test("batch rows get no per-job notices but every transition calls afterTransition", async (t) => {
  const { env, deps, transitions } = setup(t);
  seedWork(env, W1);
  const j = submit(env, { work: "星降る灯台", batch: { batch_id: "B20261123-01", line: 3 } });
  await runWorker(env, deps, { once: true });
  assert.equal(job(env, j.job_id).job.state, "built");
  assert.deepEqual(listNotices(env, { job_id: j.job_id }), []);
  const states = transitions.filter((x) => x.id === j.job_id).map((x) => x.state);
  assert.ok(states.includes("queued") && states.includes("building") && states[states.length - 1] === "built", states.join(","));
});

test("notices are at most once across a worker restart (crash between build and the built save)", async (t) => {
  const { env, deps, builds } = setup(t);
  seedWork(env, W1);
  const j = submit(env, { work: "星降る灯台" });
  await runWorker(env, deps, { once: true });
  assert.equal(job(env, j.job_id).job.state, "built");
  // simulate: the previous worker died after emitting the completion notice but before saving "built"
  const loc = job(env, j.job_id);
  const crashed = { ...loc.job, state: "building" };
  fs.mkdirSync(path.join(env.queueDir, "running"), { recursive: true });
  fs.writeFileSync(path.join(env.queueDir, "running", `${j.job_id}.json`), JSON.stringify(crashed));
  fs.rmSync(loc.file);
  fs.mkdirSync(path.join(env.queueDir, "worker.lock"));
  fs.writeFileSync(path.join(env.queueDir, "worker.lock", "owner"), "999999:dead");
  const s = await runWorker(env, deps, { once: true });
  assert.equal(s.tookOverFrom, 999999);
  assert.equal(job(env, j.job_id).job.state, "built");
  assert.equal(builds.length, 2, "rebuilt once more");
  assert.equal(listNotices(env, { job_id: j.job_id }).filter((n) => n.kind === "completed").length, 1);
  assert.equal(jobLog(env, j.job_id).split(`notice ${j.job_id}.completed `).length - 1, 1, "logged once");
  assert.match(fs.readFileSync(path.join(env.queueDir, "worker.log"), "utf8"), /took over stale worker lock \(owner pid 999999/);
});

test("a second worker is refused while the first holds the lock", async (t) => {
  const { env, deps } = setup(t);
  fs.mkdirSync(path.join(env.queueDir, "worker.lock"));
  fs.writeFileSync(path.join(env.queueDir, "worker.lock", "owner"), `${process.ppid}:alive`);
  await assert.rejects(runWorker(env, deps, { once: true }), /another worker is running/);
});

// ------------------------------------------------------------------ CLI (temp env injected)

async function capture(f: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: await f(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("CLI: enqueue (--json, --priority, --url, --origin muse) / status / answer / cancel against a temp queue", async (t) => {
  const { env } = setup(t);
  const e = await capture(() => enqueueCommand(["--work", "まどマギ", "--range", "1-3話", "--priority", "high", "--origin", "muse", "--url", "https://example.org/a", "--json"], env));
  assert.equal(e.code, 0, e.err);
  const j = JSON.parse(e.out) as JobRequest;
  assert.equal(j.origin, "muse");
  assert.equal(j.options.priority, "high");
  assert.deepEqual(j.instruction_urls, [{ url: "https://example.org/a", note: "instruction (--url)" }]);
  assert.equal(job(env, j.job_id).dir, "inbox");
  assert.equal((await capture(() => enqueueCommand(["--range", "1巻"], env))).code, 2, "--work required");
  assert.equal((await capture(() => enqueueCommand(["--work", "x", "--priority", "urgent"], env))).code, 2);
  const s = await capture(() => statusCommand([], env));
  assert.match(s.out, /received 1/);
  const sj = await capture(() => statusCommand([j.job_id, "--json"], env));
  assert.equal(JSON.parse(sj.out).state, "received");
  assert.equal((await capture(() => statusCommand(["20990101-0001"], env))).code, 3);
  const bs = await capture(() => statusCommand(["--batch", "B1"], env)); // wired to batchStatus (orchestrator, CP-038)
  assert.equal(bs.code, 3);
  assert.match(bs.out + bs.err, /batch_id の形式が不正です/);
  const a = await capture(() => answerCommand([j.job_id, "--pick", "1"], env));
  assert.equal(a.code, 3, "not clarifying");
  const c = await capture(() => cancelCommand([j.job_id], env));
  assert.equal(c.code, 0, c.err);
  assert.equal(job(env, j.job_id).job.state, "cancelled");
  assert.equal((await capture(() => cancelCommand([j.job_id], env))).code, 3);
});
