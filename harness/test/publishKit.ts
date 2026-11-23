/**
 * Shared helpers for the M5 publish tests (not a test file). Everything lives in temp dirs: a fake "harness"
 * repository (git init, no remotes), a test bare, publish/, works copied from site/fixtures/works, a ledger.
 * Never touches the real works/, site/dist, publish/, publish-test/ or logs/LEDGER.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "../src/site/build.ts";
import { repoRoot } from "../src/site/stage.ts";
import { rebuildIndex, readWork } from "../src/works/store.ts";
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, resolveTarget, type PublishConfig } from "../src/publish/config.ts";
import { git, gitOut } from "../src/publish/git.ts";
import { initPublishRepo } from "../src/publish/repo.ts";
import type { PublishEnv } from "../src/publish/index.ts";
import type { BuildLike } from "../src/works/ops.ts";

export const FIXTURES = path.join(repoRoot, "site", "fixtures", "works");
export const PUB_A = "novel-akari-2020";
export const PUB_B = "anime-kumo-2021";
export const RESTRICTED = "novel-restricted-1999";
export const NO_GEN = "game-missing-2001";
export const TEST_BASE = "https://sfsh-test.invalid/";

const roots: string[] = [];
export function cleanupKit(): void {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}

export interface KitEnv extends PublishEnv {
  root: string;
  barePath: string;
  jobsDir: string;
  /** The same build as env.build, typed for takedown / purge. */
  buildFn: BuildLike;
}

/** Copy the fixture works (A, B Public with gen; RESTRICTED Restricted with gen; NO_GEN Public without gen). */
export function copyFixtureWorks(worksDir: string): void {
  for (const id of [PUB_A, PUB_B, RESTRICTED, NO_GEN]) {
    const src = path.join(FIXTURES, id);
    const dir = path.join(worksDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(src, "work.json"), path.join(dir, "work.json"));
    if (fs.existsSync(path.join(src, "gen", "public.json"))) {
      fs.mkdirSync(path.join(dir, "gen"), { recursive: true });
      fs.copyFileSync(path.join(src, "gen", "public.json"), path.join(dir, "gen", "public.json"));
    }
    const w = readWork(dir);
    w.publish_mode = id === RESTRICTED ? "Restricted" : "Public";
    fs.writeFileSync(path.join(dir, "work.json"), JSON.stringify(w, null, 2));
  }
  rebuildIndex(worksDir);
}

/**
 * A complete temp environment. `init` (default true) creates the bare + publish/ (origin = bare) like
 * `sfsh publish init`. The fake harness root is a git repository without remotes.
 */
export function makeKit(over: Partial<PublishConfig> = {}, init = true): KitEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-pub-"));
  roots.push(root);
  git(["init", "-q", root]);
  const worksDir = path.join(root, "works");
  copyFixtureWorks(worksDir);
  const ledgerPath = path.join(root, "LEDGER.md");
  fs.writeFileSync(ledgerPath, "# LEDGER (test)\n", "utf8");
  const buildFn: BuildLike = (o) => build({ worksDir: o.worksDir, out: o.out, baseUrl: o.baseUrl, a2ReportPath: path.join(root, "a2.json") });
  const config = parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, ...over, url_check: { timeout_s: 0, interval_s: 1 } });
  const env: KitEnv = {
    root,
    repoRoot: root,
    worksDir,
    distDir: path.join(root, "dist"),
    publishDir: path.join(root, "publish"),
    stageDir: path.join(root, "stage"),
    logDir: path.join(root, "logs", "publish"),
    ledgerPath,
    callLogDir: path.join(root, "logs", "calls"),
    lockDir: path.join(root, "publish.lock"),
    jobsDir: path.join(root, "jobs"),
    config,
    barePath: path.join(root, "publish-test", "site.git"),
    // Builds go through the real renderer (fixed staging dir + build lock), into env.distDir.
    build: buildFn,
    buildFn,
  };
  fs.mkdirSync(env.jobsDir, { recursive: true });
  if (init && !config.production_enabled) initPublishRepo(env.publishDir, resolveTarget(config, root), config, root);
  return env;
}

let cleanDist: string | null = null;
/** One real build of the fixture works (with sitemap.xml), cached per test process. */
export async function cleanFixtureDist(): Promise<string> {
  if (cleanDist && fs.existsSync(path.join(cleanDist, "release-manifest.json"))) return cleanDist;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-pubdist-"));
  roots.push(root);
  const worksDir = path.join(root, "works");
  copyFixtureWorks(worksDir);
  const out = path.join(root, "dist");
  await build({ worksDir, out, baseUrl: TEST_BASE, a2ReportPath: path.join(root, "a2.json") });
  cleanDist = out;
  return out;
}

export function putDist(env: KitEnv, src: string): void {
  fs.rmSync(env.distDir, { recursive: true, force: true });
  fs.cpSync(src, env.distDir, { recursive: true });
}

export const bareRef = (bare: string, branch = "main"): string | null => {
  const r = git(["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
};

export const bareCommitCount = (bare: string): number => Number(gitOut(["--git-dir", bare, "rev-list", "--all", "--count"]));

/** Extract every blob object of a repository (reachable or not) into dir as <oid>.txt (for trace searches). */
export function dumpAllBlobs(gitDir: string, dir: string): number {
  fs.mkdirSync(dir, { recursive: true });
  const list = gitOut(["--git-dir", gitDir, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]).split(/\r?\n/).filter(Boolean);
  let n = 0;
  for (const line of list) {
    const [oid, type] = line.split(" ");
    if (type !== "blob") continue;
    fs.writeFileSync(path.join(dir, `${oid}.txt`), git(["--git-dir", gitDir, "cat-file", "blob", oid!], { binary: true }).stdoutBuf);
    n++;
  }
  return n;
}
