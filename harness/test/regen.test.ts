/**
 * AMENDMENT 09: `sfsh regen` re-runs S3 write → compose → S4 autocheck for an existing work from saved research
 * only. Fake model ports, temp works dir; global fetch is stubbed to prove no HTTP request is made.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.ts";
import { regenCommand } from "../src/commands/regen.ts";
import { projectPublic } from "../src/gen/project.ts";
import { PROSE_SPEC, WRITE_RULES, writePrompt } from "../src/gen/prompts.ts";
import { GEN_WORK_ID, genContext, makeGenWork } from "../src/gen/testFixtures.ts";
import { proseSpecCheck, type Unit } from "../src/gen/write.ts";
import { RegenRefused, noNetworkFetcher, offlinePort, parseRegenStages, runRegen, type ModelCallStats, type RegenDeps } from "../src/job/regen.ts";
import type { ModelPort, ModelRequest } from "../src/model/types.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";

const read = (dir: string, rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
const blk = (o: Record<string, unknown>) => ({ heading: null, spoiler: "none", epistemic: "sfsh_analysis", ...o });

/** Card-shaped Haiku output; `v` marks the version so old / new text can be told apart. */
function writeOutput(v: string) {
  return {
    overview: [
      blk({ heading: `作品の骨格${v}`, paragraphs: [`信頼をめぐる物語です${v}。`, "甲と乙の関係が中心にあります。"], based_on: ["ch01", "ch02"] }),
      blk({ heading: "因果の筋", paragraphs: [`信頼の崩れが離脱を招きます${v}。`, "裏切りの発覚が対立を強めます。"], based_on: ["ev01", "ev02"] }),
      blk({ heading: "効いている理由", paragraphs: [`結末から読むと構造が見えます${v}。`, "約束が後の決別を準備しています。"], based_on: ["su01", "th01"] }),
    ],
    figure_notes: [blk({ figure: "relations", paragraphs: [`関係の変化に注目します${v}。`], based_on: ["rl01"] })],
    intros: [blk({ page: "themes", paragraphs: [`信頼の代償を扱います${v}。`], based_on: ["th01"] })],
    quiz: [{ quiz_id: "qz01", question: "甲はなぜ組織を離れたのか", answer: "信頼が崩れたからです。", explanation: "直接の原因が信頼の崩壊にあるためです。", based_on: ["ev01"], spoiler: "mid" }],
  };
}

function ports(version: { v: string }, calls: FakeCall[], opts: { failWrite?: boolean } = {}) {
  const haiku = fakePort(
    "haiku",
    (req: ModelRequest) => {
      if (req.task === "s3.write") {
        if (opts.failWrite) throw new Error("model down");
        return writeOutput(version.v);
      }
      // AMENDMENT 11: the write stage also writes the synopsis (1 plan + 1 chapter here)
      if (req.task === "s3.synopsis.plan")
        return { intro: { paragraphs: [`甲が組織を離れるまでの物語（${version.v}）です。`], based_on: ["ch01"] }, chapters: [{ heading: "離脱", phase_ids: ["ph1"], event_ids: ["ev01"], claim_ids: [], introduces: ["人物甲"], gist: "離脱まで", target_chars: 800 }] };
      if (req.task === "s3.synopsis.chapter") return { sections: [{ heading: "発覚", paragraphs: [`裏切りが（${version.v}）発覚します。`], based_on: ["ev01"], spoiler: "mid", epistemic: "canon" }] };
      return undefined;
    },
    calls,
  );
  const luna = fakePort("luna", (req) => (req.task === "s3.write.review" || req.task === "s3.synopsis.review" ? { findings: [] } : undefined), calls);
  return { haiku, luna };
}

/** Temp works dir with one fixture work that already went through S3/S4 once (version "旧"). */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-regen-"));
  const worksDir = path.join(root, "works");
  const dir = makeGenWork(worksDir);
  await projectPublic(genContext(dir, fakePort("luna", () => undefined), fakePort("haiku", () => undefined)));
  let tick = Date.parse("2026-11-23T03:00:00Z");
  const version = { v: "旧" };
  const calls: FakeCall[] = [];
  const deps = (o: { failWrite?: boolean; haiku?: ModelPort } = {}): RegenDeps => {
    const p = ports(version, calls, o);
    return { luna: p.luna, haiku: o.haiku ?? p.haiku, worksDir, logDir: path.join(root, "logs", "regen"), jobsDir: path.join(root, "logs", "jobs"), now: () => new Date((tick += 1000)) };
  };
  const first = await runRegen(GEN_WORK_ID, {}, deps());
  assert.equal(first.ok, true, first.error ?? "");
  calls.length = 0;
  return { root, worksDir, dir, version, calls, deps };
}

/** Stub global fetch for the duration of fn; returns how often it was called. */
async function withFetchTrap<T>(fn: () => Promise<T>): Promise<{ result: T; fetches: number }> {
  const orig = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("network is not allowed in regen tests");
  }) as typeof fetch;
  try {
    return { result: await fn(), fetches };
  } finally {
    globalThis.fetch = orig;
  }
}

test("writing prompt carries writing spec v2 (A10: continuous prose) and keeps the existing rules", () => {
  const p = writePrompt({ title: "作品", elements: "{}", figures: { relations: true, reverse_plot: false, matrix: false }, intros: { themes: true, context: false, interpretations: true }, hasInterpretationItems: false, quiz: [] });
  for (const s of [
    "読み応えのある読み物",
    "(1) この作品は何か",
    "(2) 人物と因果の水準で何が起きるか",
    "(3) なぜこの作品が効いているのか（構造上の工夫・テーマ）",
    "全角1200〜2500字",
    "全角800〜1500字",
    "全角400〜900字",
    "連続した散文",
    "視点を持って書く",
    "機械的なヘッジを繰り返さない",
    "事実と解釈を文の上でも分ける",
    "解釈の分岐（interpretations）の要素がない",
    "自分の言葉",
    "台詞",
    "場面の再現",
    "based_on",
  ])
    assert.ok(p.includes(s), `write prompt lacks: ${s}`);
  for (const gone of ["リード", "全角60字以内", "全角120字以内", "全角300字以内", "1文に1つの論点"]) assert.ok(!p.includes(gone), `card rule left: ${gone}`);
  assert.equal(PROSE_SPEC.paragraphMax, 300);
  // part split: an essay call asks for that page only; the frame call never asks for essays
  const ess = writePrompt({ title: "作品", elements: "{}", figures: { relations: true, reverse_plot: false, matrix: false }, intros: { themes: true, context: true, interpretations: true }, part: "context", quiz: [] });
  assert.ok(ess.includes("書くページ: context") && !ess.includes("overview（作品ページの概要）"));
  const frame = writePrompt({ title: "作品", elements: "{}", figures: { relations: true, reverse_plot: false, matrix: false }, intros: { themes: true, context: true, interpretations: true }, part: "frame", quiz: [] });
  assert.ok(frame.includes("overview（作品ページの概要）") && !frame.includes("書くページ:"));
});

test("proseSpecCheck: measures volume per page, long paragraphs and hedges as advisory, never edits", () => {
  const u = (o: Partial<Unit>): Unit => ({ id: "x", page: "overview", slot: "overview", heading: null, paragraphs: [], quiz: null, based_on: ["a"], spoiler: "none", epistemic: "sfsh_analysis", ...o });
  const long = (n: number) => "あ".repeat(n);
  const units = [
    u({ id: "ov01", heading: "見出し", paragraphs: [long(301), long(100)] }),
    u({ id: "themes_intro01", page: "themes", slot: "intro", paragraphs: [long(200) + "と読める。" + "と考えられる。" + "かもしれない。"] }),
    u({ id: "themes_intro02", page: "themes", slot: "intro", paragraphs: [long(200)] }),
    u({ id: "qz01", page: "quiz", slot: "quiz", quiz: { quiz_type: "causal", question: "問", answer: "答", explanation: "解" } }),
  ];
  const before = JSON.stringify(units);
  const r = proseSpecCheck(units);
  assert.equal(JSON.stringify(units), before, "units unchanged");
  assert.deepEqual(r.pages.map((p) => `${p.page}:${p.sections}`), ["overview:1", "themes:2"]);
  assert.equal(r.pages[0]!.chars, 3 + 301 + 100);
  assert.deepEqual(r.long_paragraphs, [{ id: "ov01", index: 0, chars: 301 }]);
  assert.deepEqual(r.below_target, ["overview", "themes"]);
  assert.deepEqual(r.hedge_over, ["themes"]);
  assert.equal(r.quiz_chars, 3);
});

test("regen: write → compose → autocheck from saved research, previous outputs backed up, no search / fetch", async () => {
  const s = await setup();
  try {
    const oldOverview = fs.readFileSync(path.join(s.dir, "gen/pages/overview.json"), "utf8");
    const oldPublic = fs.readFileSync(path.join(s.dir, "gen/public.json"), "utf8");
    const oldReport = fs.readFileSync(path.join(s.dir, "check/report.json"), "utf8");
    assert.ok(oldOverview.includes("旧"));
    s.version.v = "新";
    const { result: rec, fetches } = await withFetchTrap(() => runRegen(GEN_WORK_ID, {}, s.deps()));
    assert.equal(rec.ok, true, rec.error ?? "");
    assert.equal(fetches, 0, "no HTTP request");
    assert.deepEqual(rec.stages.map((r) => `${r.stage}:${r.status}`), ["write:done", "compose:done", "autocheck:done", "conform:done"]);
    const writes = s.calls.filter((c) => c.req.task === "s3.write").length;
    assert.ok(writes >= 3, "v2: frame + essay pages written as parallel calls");
    const pageCalls = s.calls.filter((c) => !c.req.task.startsWith("s3.synopsis"));
    // A14: the review runs per page (pages) / per run of chapters (synopsis) in parallel, one round (no findings)
    const pageReviews = pageCalls.filter((c) => c.req.task === "s3.write.review").length;
    assert.ok(pageReviews >= 1);
    assert.deepEqual(pageCalls.map((c) => `${c.port}:${c.req.task}`), [...Array(writes).fill("haiku:s3.write"), ...Array(pageReviews).fill("luna:s3.write.review")]);
    const synCalls = s.calls.filter((c) => c.req.task.startsWith("s3.synopsis")).map((c) => `${c.port}:${c.req.task}`);
    const synReviews = synCalls.filter((x) => x === "luna:s3.synopsis.review").length;
    assert.deepEqual(synCalls, ["haiku:s3.synopsis.plan", "haiku:s3.synopsis.chapter", ...Array(synReviews).fill("luna:s3.synopsis.review")]);
    assert.equal(synReviews, 2, "intro + 1 chapter → 2 partitions");
    for (const c of s.calls) {
      assert.equal(c.req.jobId, rec.job_id);
      assert.equal(c.req.tools, "none");
    }
    assert.match(rec.job_id, new RegExp(`^regen-\\d{8}-\\d{9}-${GEN_WORK_ID}$`));
    assert.deepEqual(rec.network, { fetcher_calls: 0, searches_used: 0, fetches_used: 0, budget_limits: { searches: 0, fetches: 0, wallMs: 0 } });
    assert.equal(rec.model_calls.total, writes + pageReviews + 2 + synReviews);
    assert.deepEqual(rec.model_calls.by_port, { haiku: { ok: writes + 2, failed: 0 }, luna: { ok: pageReviews + synReviews, failed: 0 } });

    // new text everywhere
    const overview = read(s.dir, "gen/pages/overview.json").blocks;
    assert.equal(overview.length, 3);
    assert.equal(overview[0].paragraphs[0], "信頼をめぐる物語です新。", "first paragraph");
    const pub = fs.readFileSync(path.join(s.dir, "gen/public.json"), "utf8");
    assert.ok(pub.includes("新") && !pub.includes("物語です旧"));
    assert.equal(pub.includes("_backup"), false, "backup never reaches public.json");
    assert.equal(read(s.dir, "check/report.json").job_id, rec.job_id);
    const wr = read(s.dir, "gen/write_report.json");
    assert.equal(wr.card_spec, undefined, "v2 reports carry prose_spec, not card_spec");
    assert.ok(wr.prose_spec.pages.some((p: { page: string }) => p.page === "overview"));
    assert.ok(wr.prose_spec.prose_chars > 0);
    assert.equal(rec.stages[0]!.metrics.prose_chars, wr.prose_spec.prose_chars);

    // backup holds the previous outputs, mirroring the work dir
    const b = path.join(s.dir, rec.backup_dir);
    assert.match(rec.backup_dir, /^gen\/_backup-\d{8}-\d{9}$/);
    assert.equal(fs.readFileSync(path.join(b, "gen/pages/overview.json"), "utf8"), oldOverview);
    assert.equal(fs.readFileSync(path.join(b, "gen/public.json"), "utf8"), oldPublic);
    assert.equal(fs.readFileSync(path.join(b, "check/report.json"), "utf8"), oldReport);
    for (const item of ["gen/write_report.json", "gen/reviews/pages.json", "gen/gen_check.json", "work.json", "nkg/review_summary.json", "check/public.before.json"]) assert.ok(fs.existsSync(path.join(b, item)), item);
    // A17: fiction has no BKG outputs; their absence is recorded without inventing files.
    assert.deepEqual(read(b, "manifest.json").missing, ["gen/book_pages.json", "gen/book_write_report.json"]);

    // logs: one-line record + progress log; INDEX rebuilt
    const recLines = fs.readFileSync(rec.record_file, "utf8").trim().split("\n");
    assert.equal(recLines.length, 1);
    assert.equal(JSON.parse(recLines[0]!).job_id, rec.job_id);
    assert.equal(path.dirname(rec.record_file), path.join(s.root, "logs", "regen"));
    assert.match(fs.readFileSync(rec.log_file, "utf8"), /stage autocheck done/);
    assert.equal(rec.index_rebuilt, true);
    assert.deepEqual(read(s.worksDir, "INDEX.json").works.map((w: { work_id: string }) => w.work_id), [GEN_WORK_ID]);
    assert.equal(fs.existsSync(path.join(s.root, "logs", "regen", `${GEN_WORK_ID}.lock`)), false, "lock released");
    assert.equal(fs.existsSync(path.join(s.dir, "research", "budgets")), false, "regen writes no research budget files");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("regen --stages: subset runs in canonical order; compose/autocheck alone make no model calls", async () => {
  const s = await setup();
  try {
    assert.deepEqual(parseRegenStages(["autocheck", "compose"]), ["compose", "autocheck"]);
    assert.throws(() => parseRegenStages(["search_r1"]), RegenRefused);
    assert.throws(() => parseRegenStages([""]), RegenRefused);
    const rec = await runRegen(GEN_WORK_ID, { stages: ["autocheck", "compose"] }, s.deps());
    assert.equal(rec.ok, true, rec.error ?? "");
    assert.deepEqual(rec.stages.map((r) => r.stage), ["compose", "autocheck"]);
    assert.equal(s.calls.length, 0);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("regen refuses Restricted works, missing NKG / projection, invalid ids and live jobs — nothing written", async () => {
  const s = await setup();
  try {
    const logDir = path.join(s.root, "logs", "regen");
    const snapshot = () => [fs.readdirSync(path.join(s.dir, "gen")).sort().join(","), fs.readdirSync(logDir).sort().join(",")];
    const before = snapshot();
    const work = read(s.dir, "work.json");
    fs.writeFileSync(path.join(s.dir, "work.json"), JSON.stringify({ ...work, publish_mode: "Restricted" }));
    await assert.rejects(runRegen(GEN_WORK_ID, {}, s.deps()), (e) => e instanceof RegenRefused && /Restricted/.test(e.message));
    fs.writeFileSync(path.join(s.dir, "work.json"), JSON.stringify(work));

    for (const rel of ["gen/projection.json", "nkg/nkg.json"]) {
      fs.renameSync(path.join(s.dir, rel), path.join(s.dir, `${rel}.off`));
      await assert.rejects(runRegen(GEN_WORK_ID, {}, s.deps()), (e) => e instanceof RegenRefused && e.message.includes(rel));
      fs.renameSync(path.join(s.dir, `${rel}.off`), path.join(s.dir, rel));
    }
    for (const id of ["../etc", "_staging-20261123-0003", "novel-missing-1999", ""]) await assert.rejects(runRegen(id, {}, s.deps()), RegenRefused, id);

    // a live job on the same work (its pid is alive: the test runner's parent)
    const jobsDir = path.join(s.root, "logs", "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "20991231-0001.state.json"), JSON.stringify({ job_id: "20991231-0001", work_id: GEN_WORK_ID, pid: process.ppid, state: "generating" }));
    await assert.rejects(runRegen(GEN_WORK_ID, {}, s.deps()), (e) => e instanceof RegenRefused && /running job 20991231-0001/.test(e.message));
    fs.rmSync(jobsDir, { recursive: true, force: true });

    assert.deepEqual(snapshot(), before, "no backup, no log, no record for a refused run");
    assert.equal(s.calls.length, 0);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("regen: a failing stage stops the run (exit 3), keeps the previous outputs and the backup", async () => {
  const s = await setup();
  try {
    const oldOverview = fs.readFileSync(path.join(s.dir, "gen/pages/overview.json"), "utf8");
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    let code: number;
    try {
      code = await regenCommand([GEN_WORK_ID], { ...s.deps({ failWrite: true }), maxAttempts: 2 });
    } finally {
      console.log = log;
    }
    assert.equal(code, 3);
    const text = out.join("\n");
    assert.match(text, /write: failed \(attempt 2/);
    assert.match(text, /FAILED/);
    assert.match(text, /backup: works\/.*\/gen\/_backup-/);
    assert.equal(fs.readFileSync(path.join(s.dir, "gen/pages/overview.json"), "utf8"), oldOverview, "nothing overwritten");
    const recFile = fs.readdirSync(path.join(s.root, "logs", "regen")).filter((f) => f.endsWith(".json")).sort().pop()!;
    const rec = JSON.parse(fs.readFileSync(path.join(s.root, "logs", "regen", recFile), "utf8"));
    assert.equal(rec.ok, false);
    assert.deepEqual(rec.stages.map((r: { stage: string; status: string; attempts: number }) => `${r.stage}:${r.status}:${r.attempts}`), ["write:failed:2", "compose:skipped:0", "autocheck:skipped:0", "conform:skipped:0"]);
    assert.ok(fs.existsSync(path.join(s.dir, rec.backup_dir, "gen/pages/overview.json")));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("regen: two different works in parallel are independent (INDEX has both); a second regen of the same work is refused", async () => {
  const s = await setup();
  try {
    // clone the fixture work under a second id
    const id2 = "novel-gen-fixture-two-2002";
    const dir2 = path.join(s.worksDir, id2);
    fs.cpSync(s.dir, dir2, { recursive: true });
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(dir2).filter((f) => f.endsWith(".json"))) fs.writeFileSync(f, fs.readFileSync(f, "utf8").split(GEN_WORK_ID).join(id2));

    // gate the first regen inside its write call so the overlap is deterministic
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const base = s.deps();
    const gated: ModelPort = { port: "haiku", modelId: "gated", call: async (req) => (await gate, base.haiku.call(req)) };
    s.version.v = "並";
    const p1 = runRegen(GEN_WORK_ID, {}, { ...base, haiku: gated });
    const p2 = runRegen(id2, {}, s.deps());
    await assert.rejects(runRegen(GEN_WORK_ID, {}, s.deps()), (e) => e instanceof RegenRefused && /another regen/.test(e.message));
    open();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true, r1.error ?? "");
    assert.equal(r2.ok, true, r2.error ?? "");
    assert.notEqual(r1.record_file, r2.record_file);
    assert.equal(read(dir2, "gen/public.json").work.work_id, id2);
    assert.deepEqual(read(s.worksDir, "INDEX.json").works.map((w: { work_id: string }) => w.work_id), [GEN_WORK_ID, id2]);
    assert.equal(fs.existsSync(path.join(s.root, "logs", "regen", "index.lock")), false);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("regen guards: the fetcher always throws; model-side tools (web search) are refused before the CLI is called", async () => {
  const counter = { calls: 0 };
  await assert.rejects(noNetworkFetcher(counter).fetchAll([], {} as never), /network fetch is disabled/);
  assert.equal(counter.calls, 1);
  const stats: ModelCallStats = { total: 0, by_port: { haiku: { ok: 0, failed: 0 }, luna: { ok: 0, failed: 0 } }, by_task: {}, refused_tools: 0 };
  const calls: FakeCall[] = [];
  const p = offlinePort(fakePort("luna", () => ({ findings: [] }), calls), stats);
  await assert.rejects(p.call({ task: "x", prompt: "p", schema: { type: "object" }, tools: "web_search" }), /tools "web_search" are disabled/);
  assert.equal(calls.length, 0, "inner port never called");
  assert.equal(stats.refused_tools, 1);
});

test("CLI: regen is listed in help; missing args / unknown option → 2; real run refused under the test runner", async () => {
  const errs: string[] = [];
  const outs: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => void outs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    assert.equal(await main(["help"]), 0);
    assert.ok(outs.join("\n").includes("regen <work_id> [--stages write,compose,autocheck,conform] [--parts pages,synopsis] [--json]"));
    assert.equal(await main(["regen"]), 2);
    assert.equal(await main(["regen", GEN_WORK_ID, "--bogus"]), 2);
    assert.equal(await main(["regen", GEN_WORK_ID]), 2);
    assert.match(errs.join("\n"), /refusing to run real model calls against the real works under the test runner/);
  } finally {
    console.log = log;
    console.error = error;
  }
});

test("CLI: regen --json prints the record on stdout (progress on stderr)", async () => {
  const s = await setup();
  try {
    const outs: string[] = [];
    const errs: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (...a: unknown[]) => void outs.push(a.join(" "));
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    let code: number;
    try {
      code = await regenCommand([GEN_WORK_ID, "--stages", "write,compose,autocheck", "--json"], s.deps());
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.equal(code, 0, errs.join("\n"));
    const rec = JSON.parse(outs.join("\n"));
    assert.equal(rec.schema, "sfsh-regen/1");
    assert.equal(rec.ok, true);
    assert.match(errs.join("\n"), /write: done in/);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
