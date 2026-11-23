/**
 * WP-3.3: hold / release with history, takedown / purge (local part). Temp dirs only — never touches the real
 * works/, logs/LEDGER.md, logs/jobs/ or site/dist. Note: build() recreates the fixed site/.input/ staging dir; if a
 * concurrent build elsewhere collides (ENOENT around site/.input), rerun.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "../src/site/build.ts";
import { repoRoot } from "../src/site/stage.ts";
import { rebuildIndex, readWork } from "../src/works/store.ts";
import type { Work, WorksIndex } from "../src/works/types.ts";
import {
  distTraces,
  holdWork,
  isWorkRestricted,
  purgeWork,
  releaseWork,
  takedownWork,
  TakedownVerificationError,
  UnknownWorkError,
  PUSH_PENDING,
  URL_404_PENDING,
  type BuildLike,
} from "../src/works/ops.ts";
import { holdCommand, purgeCommand, releaseCommand, takedownCommand, type OpsCommandEnv } from "../src/commands/ops.ts";
import { main } from "../src/cli.ts";

const FIXTURES = path.join(repoRoot, "site", "fixtures", "works");
const A = "novel-akari-2020";
const B = "anime-kumo-2021";
/** Identifying strings of A (work.json title/aliases, public title_original/creator/publisher) and a distinctive public sentence. */
const A_NEEDLES = [A, "灯りの航路", "Routes of Light", "灯路", "あかりのこおろ", "架空 葵", "架空書房", "知識を独占しないという約束"];
const BASE_URL = "https://example.test/sfsh/";
const LEDGER_HEAD = "# LEDGER (test)\n\n- existing line without trailing newline";
const OPS_LINE = /^- OPS \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \| (hold|release|takedown|purge) \| work=[a-z0-9-]+ \| actor=[^|]+ \| reason=[^|]+ \| .+$/;

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

interface Env {
  root: string;
  worksDir: string;
  jobsDir: string;
  ledgerPath: string;
  out: string;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-ops-"));
  roots.push(root);
  const worksDir = path.join(root, "works");
  for (const id of [A, B]) {
    const dir = path.join(worksDir, id);
    fs.mkdirSync(path.join(dir, "gen"), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, id, "work.json"), path.join(dir, "work.json"));
    fs.copyFileSync(path.join(FIXTURES, id, "gen", "public.json"), path.join(dir, "gen", "public.json"));
    for (const sub of ["research", "nkg", "releases", path.join("gen", "reviews")]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, "research", "sources.json"), "[]\n");
    fs.writeFileSync(path.join(dir, "nkg", "nkg.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "releases", "r0001.json"), "{}\n");
    // Fixtures are Public; make sure.
    const w = readWork(dir);
    w.publish_mode = "Public";
    fs.writeFileSync(path.join(dir, "work.json"), JSON.stringify(w, null, 2));
  }
  rebuildIndex(worksDir);
  const jobsDir = path.join(root, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const ledgerPath = path.join(root, "LEDGER.md");
  fs.writeFileSync(ledgerPath, LEDGER_HEAD, "utf8");
  return { root, worksDir, jobsDir, ledgerPath, out: path.join(root, "dist") };
}

function ops(env: Env, workId: string, reason?: string) {
  return { worksDir: env.worksDir, workId, reason, jobsDir: env.jobsDir, ledgerPath: env.ledgerPath };
}

function catalogIds(out: string): string[] {
  return (JSON.parse(fs.readFileSync(path.join(out, "catalog.json"), "utf8")) as { work_id: string }[]).map((w) => w.work_id);
}

function indexMode(worksDir: string, id: string): string | undefined {
  return (JSON.parse(fs.readFileSync(path.join(worksDir, "INDEX.json"), "utf8")) as WorksIndex).works.find((w) => w.work_id === id)?.publish_mode;
}

function ledgerOpsLines(ledgerPath: string): string[] {
  return fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.startsWith("- OPS "));
}

function writeJob(jobsDir: string, jobId: string, workId: string, state: string, pid: number | null): string {
  const f = path.join(jobsDir, `${jobId}.state.json`);
  fs.writeFileSync(f, JSON.stringify({ job_id: jobId, work_id: workId, state, pid, updated_at: "2026-11-23T00:00:00+09:00", error: null }, null, 2) + "\n");
  return f;
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid);
  return r.pid;
}

/** Minimal stand-in for build(): writes catalog.json + one page per Public work (or all works when `leak`). */
function fakeBuild(leak = false): BuildLike {
  return async ({ worksDir, out }) => {
    fs.rmSync(out!, { recursive: true, force: true });
    fs.mkdirSync(out!, { recursive: true });
    const idx = JSON.parse(fs.readFileSync(path.join(worksDir!, "INDEX.json"), "utf8")) as WorksIndex;
    const works = idx.works.filter((w) => leak || w.publish_mode === "Public");
    fs.writeFileSync(path.join(out!, "catalog.json"), JSON.stringify(works.map((w) => ({ work_id: w.work_id, title: w.title }))));
    fs.writeFileSync(path.join(out!, "index.html"), `<ul>${works.map((w) => `<li>${w.title}</li>`).join("")}</ul>`);
    return { works: works.length };
  };
}

// ---------- real-build round trip (§7.2 M3: held work appears nowhere in the build, comes back on release) ----------

let rt: Env;
before(async () => {
  rt = makeEnv();
});

test("baseline build: both Public works are present", async () => {
  await build({ worksDir: rt.worksDir, out: rt.out, baseUrl: BASE_URL });
  assert.deepEqual(catalogIds(rt.out).sort(), [A, B].sort());
  assert.ok(fs.existsSync(path.join(rt.out, "works", A, "index.html")));
  assert.ok(fs.existsSync(path.join(rt.out, "works", B, "index.html")));
  assert.ok(fs.existsSync(path.join(rt.out, "sitemap.xml")));
  // The needles really do occur in a normal build (so the "nowhere" check below is meaningful).
  const found = new Set(distTraces(rt.out, A_NEEDLES).map((t) => t.needle));
  for (const n of [A, "灯りの航路", "Routes of Light", "灯路", "あかりのこおろ", "知識を独占しないという約束"]) assert.ok(found.has(n), `baseline build should contain ${n}`);
});

test("hold: Restricted + history + INDEX + ledger line, immediate; next build has no trace of the work", async () => {
  const r = holdWork(ops(rt, A, "権利者からの申し立て（試験）"));
  assert.equal(r.event, "hold");
  assert.equal(r.previous_publish_mode, "Public");
  assert.equal(r.publish_mode, "Restricted");
  assert.equal(r.no_change, false);
  assert.ok(r.elapsed_ms < 1000, `hold should be immediate, took ${r.elapsed_ms} ms`);
  console.log(`# hold elapsed_ms=${r.elapsed_ms.toFixed(2)}`);

  const w = readWork(path.join(rt.worksDir, A));
  assert.equal(w.publish_mode, "Restricted");
  const h = w.history[w.history.length - 1]!;
  assert.equal(h.event, "hold");
  assert.equal(h.actor, "owner(cli)");
  assert.equal(h.reason, "権利者からの申し立て（試験）");
  assert.equal(h.job_id, null);
  assert.match(h.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(indexMode(rt.worksDir, A), "Restricted");
  assert.equal(indexMode(rt.worksDir, B), "Public");
  assert.equal(isWorkRestricted(rt.worksDir, A), true);
  assert.equal(isWorkRestricted(rt.worksDir, B), false);
  assert.equal(isWorkRestricted(rt.worksDir, "no-such-work"), false);

  const text = fs.readFileSync(rt.ledgerPath, "utf8");
  assert.ok(text.startsWith(LEDGER_HEAD + "\n- OPS "), "existing ledger kept; OPS line starts on a new line");
  const lines = ledgerOpsLines(rt.ledgerPath);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, OPS_LINE);
  assert.ok(lines[0]!.includes(`| hold | work=${A} | actor=owner(cli) | reason=権利者からの申し立て（試験） |`));

  await build({ worksDir: rt.worksDir, out: rt.out, baseUrl: BASE_URL });
  assert.deepEqual(distTraces(rt.out, A_NEEDLES), [], "held work must appear nowhere in dist");
  assert.deepEqual(catalogIds(rt.out), [B]);
  assert.ok(!fs.existsSync(path.join(rt.out, "works", A)));
  assert.ok(fs.existsSync(path.join(rt.out, "works", B, "index.html")));
  assert.ok(distTraces(rt.out, [B, "クラウド工房"]).length > 0, "work B is still built");
  assert.ok(!fs.readFileSync(path.join(rt.out, "sitemap.xml"), "utf8").includes(A));
});

test("hold again: idempotent, recorded as already Restricted", () => {
  const r = holdWork(ops(rt, A));
  assert.equal(r.no_change, true);
  assert.equal(r.reason, null);
  const w = readWork(path.join(rt.worksDir, A));
  assert.equal(w.publish_mode, "Restricted");
  const h = w.history[w.history.length - 1]!;
  assert.equal(h.event, "hold");
  assert.equal(h.reason, undefined);
  assert.match(h.detail!, /already Restricted/);
  const lines = ledgerOpsLines(rt.ledgerPath);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /\| reason=- \|/);
});

test("release: Public + history + ledger; next build has the work back", async () => {
  const r = releaseWork(ops(rt, A, "確認済み"));
  assert.equal(r.previous_publish_mode, "Restricted");
  assert.equal(r.publish_mode, "Public");
  assert.ok(r.elapsed_ms < 1000);
  console.log(`# release elapsed_ms=${r.elapsed_ms.toFixed(2)}`);
  const w = readWork(path.join(rt.worksDir, A));
  assert.equal(w.publish_mode, "Public");
  assert.deepEqual(w.history.slice(-3).map((h) => h.event), ["hold", "hold", "release"]);
  assert.equal(indexMode(rt.worksDir, A), "Public");
  const lines = ledgerOpsLines(rt.ledgerPath);
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, OPS_LINE);
  assert.ok(lines[2]!.includes(`| release | work=${A} |`));

  await build({ worksDir: rt.worksDir, out: rt.out, baseUrl: BASE_URL });
  assert.deepEqual(catalogIds(rt.out).sort(), [A, B].sort());
  assert.ok(fs.existsSync(path.join(rt.out, "works", A, "index.html")));
  assert.ok(fs.readFileSync(path.join(rt.out, "sitemap.xml"), "utf8").includes(`works/${A}/`));
  assert.ok(distTraces(rt.out, ["知識を独占しないという約束"]).length > 0);
});

test("release of a Public work is recorded as no change", () => {
  const r = releaseWork(ops(rt, B));
  assert.equal(r.no_change, true);
  assert.match(r.history_entry.detail!, /already Public/);
});

// ---------- jobs ----------

test("hold: non-running jobs of the work -> held; a live-pid job and other jobs untouched; release reports held jobs", () => {
  const env = makeEnv();
  const idle = writeJob(env.jobsDir, "20261123-0001", A, "generating", null);
  const live = writeJob(env.jobsDir, "20261123-0002", A, "structuring", process.pid);
  const done = writeJob(env.jobsDir, "20261123-0003", A, "done", null);
  const other = writeJob(env.jobsDir, "20261123-0004", B, "generating", null);
  const stale = writeJob(env.jobsDir, "20261123-0005", A, "researching", deadPid());
  const before = Object.fromEntries([live, done, other].map((f) => [f, fs.readFileSync(f, "utf8")]));

  const r = holdWork(ops(env, A, "job test"));
  const byId = Object.fromEntries(r.jobs.map((j) => [j.job_id, j]));
  assert.deepEqual(Object.keys(byId).sort(), ["20261123-0001", "20261123-0002", "20261123-0005"]);
  assert.equal(byId["20261123-0001"]!.action, "held");
  assert.equal(byId["20261123-0001"]!.previous_state, "generating");
  assert.equal(byId["20261123-0002"]!.action, "running");
  assert.equal(byId["20261123-0002"]!.pid, process.pid);
  assert.equal(byId["20261123-0005"]!.action, "held");

  for (const f of [idle, stale]) {
    const st = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.equal(st.state, "held");
    assert.equal(st.pid, null);
  }
  for (const [f, text] of Object.entries(before)) assert.equal(fs.readFileSync(f, "utf8"), text, `${path.basename(f)} must be untouched`);
  assert.ok(fs.readdirSync(env.jobsDir).every((n) => !n.endsWith(".tmp")), "no temp files left");
  const log = fs.readFileSync(path.join(env.jobsDir, "20261123-0001.log"), "utf8");
  assert.match(log, /job held by hold \(actor=owner\(cli\), reason=job test; was generating\)/);
  assert.match(log, /sfsh job resume 20261123-0001/);
  assert.ok(!fs.existsSync(path.join(env.jobsDir, "20261123-0002.log")));
  assert.match(r.history_entry.detail!, /jobs held: 20261123-0001,20261123-0005/);
  assert.match(r.history_entry.detail!, /running jobs \(held at next stage boundary\): 20261123-0002/);

  const rel = releaseWork(ops(env, A));
  assert.deepEqual(rel.jobs.map((j) => [j.job_id, j.action]), [["20261123-0001", "held_waiting"], ["20261123-0005", "held_waiting"]]);
  assert.equal(JSON.parse(fs.readFileSync(idle, "utf8")).state, "held", "release does not auto-run held jobs");
});

test("unknown work_id throws UnknownWorkError and writes nothing", () => {
  const env = makeEnv();
  assert.throws(() => holdWork(ops(env, "novel-nothing-1900")), UnknownWorkError);
  assert.throws(() => releaseWork(ops(env, "../" + A)), UnknownWorkError);
  assert.equal(fs.readFileSync(env.ledgerPath, "utf8"), LEDGER_HEAD);
});

// ---------- dist verification ----------

test("distTraces: finds raw, NFKC-variant, HTML-escaped and JSON-escaped traces; skips nothing else", () => {
  const env = makeEnv();
  const d = path.join(env.root, "fake-dist");
  fs.mkdirSync(path.join(d, "genres", "x"), { recursive: true });
  fs.writeFileSync(path.join(d, "a.html"), "<p>Ｒｏｕｔｅｓ ｏｆ Ｌｉｇｈｔ</p>"); // full-width → NFKC
  fs.writeFileSync(path.join(d, "genres", "x", "index.html"), "<p>Tom &amp; Jerry</p>");
  fs.writeFileSync(path.join(d, "search.json"), '{"t":"\\u706f\\u308a\\u306e\\u822a\\u8def"}'); // 灯りの航路 escaped
  fs.writeFileSync(path.join(d, "clean.txt"), "nothing here");
  const t = distTraces(d, ["Routes of Light", "Tom & Jerry", "灯りの航路", "absent", ""]);
  assert.deepEqual(t.map((x) => `${x.file}|${x.needle}`).sort(), ["a.html|Routes of Light", "genres/x/index.html|Tom & Jerry", "search.json|灯りの航路"]);
});

// ---------- takedown / purge (local part) ----------

test("takedown (real build): Restricted, rebuilt without the work, verified 0 traces, no publish target → push/404 not run, recorded", async () => {
  const env = makeEnv();
  await build({ worksDir: env.worksDir, out: env.out, baseUrl: BASE_URL });
  assert.ok(catalogIds(env.out).includes(A));
  const r = await takedownWork({ ...ops(env, A, "申し立て（試験）"), buildOut: env.out, baseUrl: BASE_URL });
  console.log(`# takedown elapsed_ms=${r.elapsed_ms.toFixed(0)} build_ms=${r.build.elapsed_ms.toFixed(0)}`);
  assert.equal(r.publish_mode, "Restricted");
  assert.deepEqual(r.verification.traces, []);
  assert.ok(r.verification.files_scanned > 5);
  for (const n of [A, "灯りの航路", "Routes of Light", "灯路", "あかりのこおろ"]) assert.ok(r.verification.needles.includes(n), `needle ${n}`);
  assert.equal(r.push, PUSH_PENDING);
  assert.equal(r.url_404_check, URL_404_PENDING);
  assert.deepEqual(distTraces(env.out, A_NEEDLES), []);
  assert.deepEqual(catalogIds(env.out), [B]);
  assert.ok(!fs.readFileSync(path.join(env.out, "sitemap.xml"), "utf8").includes(A));
  // Local takedown does not delete data.
  assert.ok(fs.existsSync(path.join(env.worksDir, A, "gen", "public.json")));
  const w = readWork(path.join(env.worksDir, A));
  const h = w.history[w.history.length - 1]!;
  assert.equal(h.event, "takedown");
  assert.equal(w.history.filter((x) => x.event === "takedown").length, 1, "one history entry per takedown");
  assert.match(h.detail!, /0 traces/);
  assert.match(h.detail!, /push not run: no publish target/);
  const lines = ledgerOpsLines(env.ledgerPath);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, OPS_LINE);
  assert.ok(lines[0]!.includes(`| takedown | work=${A} |`));
});

test("takedown: a build that still leaks the work fails verification (throws) and the failure is recorded", async () => {
  const env = makeEnv();
  await assert.rejects(takedownWork({ ...ops(env, A), buildOut: env.out, build: fakeBuild(true) }), (e: unknown) => {
    assert.ok(e instanceof TakedownVerificationError);
    assert.ok(e.result.verification.traces.length > 0);
    assert.match(e.message, /verification FAILED/);
    return true;
  });
  assert.equal(isWorkRestricted(env.worksDir, A), true, "still Restricted after the failed verification");
  const w = readWork(path.join(env.worksDir, A));
  assert.match(w.history[w.history.length - 1]!.detail!, /verification FAILED/);
  assert.match(ledgerOpsLines(env.ledgerPath)[0]!, /verification FAILED/);
});

test("purge (real build): takedown + gen/, releases/ and check/ deleted; research/, nkg/, work.json kept", async () => {
  const env = makeEnv();
  fs.mkdirSync(path.join(env.worksDir, A, "check"), { recursive: true });
  fs.writeFileSync(path.join(env.worksDir, A, "check", "public.before.json"), "{}");
  const r = await purgeWork({ ...ops(env, A, "完全消去の要請（試験）"), buildOut: env.out, baseUrl: BASE_URL });
  const dir = path.join(env.worksDir, A);
  assert.ok(!fs.existsSync(path.join(dir, "gen")));
  assert.ok(!fs.existsSync(path.join(dir, "releases")));
  assert.ok(!fs.existsSync(path.join(dir, "check")));
  for (const keep of ["research/sources.json", "nkg/nkg.json", "work.json"]) assert.ok(fs.existsSync(path.join(dir, keep)), keep);
  assert.deepEqual(r.deleted, ["gen/", "releases/", "check/"]);
  assert.deepEqual(r.kept, ["nkg/", "research/", "work.json"]);
  assert.deepEqual(r.verification.traces, []);
  assert.ok(r.verification.needles.includes("Routes of Light"), "needles read from public.json before it was deleted");
  assert.deepEqual(distTraces(env.out, A_NEEDLES), []);
  assert.deepEqual(catalogIds(env.out), [B]);
  // Work B untouched.
  assert.ok(fs.existsSync(path.join(env.worksDir, B, "gen", "public.json")));
  const w = readWork(dir) as Work;
  assert.equal(w.publish_mode, "Restricted");
  assert.equal(w.history[w.history.length - 1]!.event, "purge");
  assert.match(w.history[w.history.length - 1]!.detail!, /deleted gen\/,releases\//);
  assert.ok(ledgerOpsLines(env.ledgerPath)[0]!.includes(`| purge | work=${A} | actor=owner(cli) | reason=完全消去の要請（試験） |`));
});

// ---------- CLI ----------

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("CLI: exit codes for hold/release/takedown/purge", async () => {
  // Through main(): usage errors and an unknown work_id (read-only against the real works/).
  for (const cmd of ["hold", "release", "takedown", "purge"]) {
    assert.equal((await capture(() => main([cmd]))).code, 2, `${cmd} without work_id`);
    const r = await capture(() => main([cmd, "novel-no-such-work-0000"]));
    assert.equal(r.code, 2, `${cmd} unknown work`);
    assert.match(r.err, /unknown work_id: novel-no-such-work-0000/);
  }
  const help = await capture(() => main(["help"]));
  assert.match(help.out, /takedown <work_id>.*snapshot push \+ 404 check/);
  assert.doesNotMatch(help.out, /hold <work_id>[^\n]*\[stub/);

  // Command functions against temp dirs.
  const env = makeEnv();
  const cenv: OpsCommandEnv = { worksDir: env.worksDir, jobsDir: env.jobsDir, ledgerPath: env.ledgerPath, defaultOut: env.out, build: fakeBuild() };
  assert.equal((await capture(() => holdCommand([A, "--bogus"], cenv))).code, 2);
  assert.equal((await capture(() => holdCommand([A, "--reason"], cenv))).code, 2);
  assert.equal((await capture(() => holdCommand([A, B], cenv))).code, 2);
  let r = await capture(() => holdCommand([A, "--reason", "cli test"], cenv));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hold novel-akari-2020: Public -> Restricted/);
  r = await capture(() => holdCommand([A, "--json"], cenv));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).no_change, true);
  r = await capture(() => releaseCommand([A], cenv));
  assert.equal(r.code, 0);
  assert.match(r.out, /Restricted -> Public/);
  r = await capture(() => takedownCommand([A, "--reason", "x"], cenv));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /push: not run: no publish target/);
  assert.match(r.out, /URL 404 check: not run: no publish target/);
  assert.ok(fs.existsSync(path.join(env.out, "catalog.json")), "default --out used");
  assert.equal((await capture(() => takedownCommand([A], { ...cenv, build: fakeBuild(true) }))).code, 3, "verification failure → 3");
  assert.equal((await capture(() => purgeCommand(["novel-nothing-1900"], cenv))).code, 2);
  const out2 = path.join(env.root, "dist2");
  r = await capture(() => purgeCommand([A, "--out", out2], cenv));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /deleted: gen\/, releases\//);
  assert.ok(fs.existsSync(path.join(out2, "catalog.json")));
  assert.equal(ledgerOpsLines(env.ledgerPath).length, 6);
  for (const l of ledgerOpsLines(env.ledgerPath)) assert.match(l, OPS_LINE);
});
