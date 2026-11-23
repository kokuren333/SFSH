/**
 * The Pages-side working clone publish/ (REQUIREMENTS §6.3-1, -5, -8; WP-5.1 / 5.2):
 *  - initPublishRepo: (gate closed) create the local test bare repository if absent and publish/ as an independent
 *    repository whose only remote `origin` is the target.
 *  - checkRemotes:    the remote mix-up check (6.3-8) run right before every push.
 *  - snapshotCommit:  replace the clone's content with the staged dist and make ONE parentless commit; drop every
 *    other ref + reflog and prune, so nothing taken down survives even locally.
 *  - pushSnapshot:    force-push that single commit (the only `git push` in the harness).
 *  - verifyBare:      post-push check against a local bare: ref = commit, one commit in history, files = dist,
 *    every blob's sha256 = release-manifest.json.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, gitOut, lsTree, readBlobs } from "./git.ts";
import { isNetworkUrl, normalizeLocalPath, type PublishConfig, type PublishTarget } from "./config.ts";

export class RemoteCheckError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`remote mix-up check failed (6.3-8): ${problems.join("; ")}`);
    this.name = "RemoteCheckError";
    this.problems = problems;
  }
}

/** Normalize any remote URL for comparison. Local paths → absolute forward-slash; network URLs → lower-case, no trailing "/" or ".git". */
export function normalizeRemote(u: string, base: string): string {
  const s = u.trim();
  if (isNetworkUrl(s)) return s.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return normalizeLocalPath(s, base).replace(/\.git$/i, "").toLowerCase();
}

export function isBareRepo(p: string): boolean {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return false;
  const r = git(["--git-dir", p, "rev-parse", "--is-bare-repository"], { allowFail: true });
  return r.code === 0 && r.stdout.trim() === "true";
}

function remotesOf(dir: string, guard: string[]): { name: string; fetch: string[]; push: string[] }[] {
  const r = git(["remote"], { cwd: dir, guard, allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      fetch: git(["remote", "get-url", "--all", name], { cwd: dir, guard, allowFail: true }).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      push: git(["remote", "get-url", "--push", "--all", name], { cwd: dir, guard, allowFail: true }).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    }));
}

/** Absolute git dir of the repository that contains `dir` (null when none). */
function absGitDir(dir: string, guard: string[] = []): string | null {
  const r = git(["rev-parse", "--absolute-git-dir"], { cwd: dir, guard, allowFail: true });
  return r.code === 0 ? normalizeLocalPath(r.stdout.trim()) : null;
}

export interface RemoteCheckReport {
  ok: boolean;
  publish_dir: string;
  target: string;
  target_kind: PublishTarget["kind"];
  publish_remotes: { name: string; fetch: string[]; push: string[] }[];
  harness_remotes: { name: string; fetch: string[]; push: string[] }[];
  problems: string[];
}

/**
 * 6.3-8 remote mix-up check. Problems (any → abort the push):
 *  publish/ missing, not its own repository (toplevel / git dir), bare, the same repository as the harness;
 *  remotes other than exactly `origin`; any fetch/push URL of origin (insteadOf expanded) ≠ target;
 *  target equal to a harness-side remote URL; the harness side registering the target or publish/'s URL;
 *  (gate closed) target not an existing bare repository.
 */
export function checkRemotes(publishDir: string, target: PublishTarget, harnessRoot: string): RemoteCheckReport {
  const problems: string[] = [];
  const pd = normalizeLocalPath(publishDir, harnessRoot);
  const guard = target.gitGuard;
  const report: RemoteCheckReport = { ok: false, publish_dir: pd, target: target.url, target_kind: target.kind, publish_remotes: [], harness_remotes: [], problems };
  const harnessGitDir = absGitDir(harnessRoot);
  report.harness_remotes = harnessGitDir ? remotesOf(harnessRoot, guard) : [];
  const t = normalizeRemote(target.url, harnessRoot);

  if (target.kind === "test" && (!target.barePath || !isBareRepo(target.barePath))) problems.push(`test target ${target.url} is not an existing bare repository (run: sfsh publish init)`);
  if (!fs.existsSync(publishDir) || !fs.statSync(publishDir).isDirectory()) {
    problems.push(`${pd} does not exist (run: sfsh publish init)`);
  } else {
    const top = git(["rev-parse", "--show-toplevel"], { cwd: publishDir, guard, allowFail: true });
    const gd = absGitDir(publishDir, guard);
    if (top.code !== 0 || normalizeLocalPath(top.stdout.trim()) !== pd) problems.push(`${pd} is not its own git repository (toplevel: ${top.code === 0 ? top.stdout.trim() : "none"})`);
    if (!gd || gd !== `${pd}/.git`) problems.push(`publish git dir is ${gd ?? "none"}, expected ${pd}/.git (no gitfile / worktree / submodule)`);
    if (gd && harnessGitDir && gd === harnessGitDir) problems.push("publish/ resolves to the harness repository");
    const bare = git(["rev-parse", "--is-bare-repository"], { cwd: publishDir, guard, allowFail: true });
    if (bare.stdout.trim() === "true") problems.push("publish/ is a bare repository (expected a working clone)");
    report.publish_remotes = top.code === 0 && normalizeLocalPath(top.stdout.trim()) === pd ? remotesOf(publishDir, guard) : [];
    const names = report.publish_remotes.map((r) => r.name);
    if (names.length !== 1 || names[0] !== "origin") problems.push(`publish/ must have exactly one remote "origin" (has: ${names.join(", ") || "none"})`);
    const origin = report.publish_remotes.find((r) => r.name === "origin");
    if (origin) {
      if (!origin.fetch.length || !origin.push.length) problems.push("origin has no URL");
      for (const u of [...origin.fetch, ...origin.push]) if (normalizeRemote(u, publishDir) !== t) problems.push(`origin URL "${u}" does not match the configured target "${target.url}"`);
    }
  }
  for (const hr of report.harness_remotes) {
    for (const u of [...hr.fetch, ...hr.push]) {
      const n = normalizeRemote(u, harnessRoot);
      if (n === t) problems.push(`the harness repository has remote "${hr.name}" = the Pages target; refusing (never register the Pages remote on the harness side)`);
      const origin = report.publish_remotes.find((r) => r.name === "origin");
      for (const pu of origin ? [...origin.fetch, ...origin.push] : []) if (normalizeRemote(pu, publishDir) === n) problems.push(`publish/ origin equals harness remote "${hr.name}"`);
    }
  }
  if (normalizeRemote(target.url, harnessRoot) === normalizeRemote(harnessRoot, harnessRoot)) problems.push("the target is the harness repository itself");
  const unique = [...new Set(problems)];
  problems.splice(0, problems.length, ...unique);
  report.ok = problems.length === 0;
  return report;
}

/** Gate closed only: create the test bare (if absent) and publish/ with origin = the bare. Idempotent. */
export function initPublishRepo(publishDir: string, target: PublishTarget, cfg: PublishConfig, harnessRoot: string): { createdBare: boolean; createdClone: boolean } {
  if (target.kind !== "test" || !target.barePath) throw new Error("publish init is only for the local test target while the production gate is closed (the real repository is set up by the opening procedure)");
  const guard = target.gitGuard;
  let createdBare = false;
  if (!fs.existsSync(target.barePath)) {
    fs.mkdirSync(target.barePath, { recursive: true });
    git(["init", "--bare", "-q", "-b", cfg.branch, target.barePath], { guard });
    createdBare = true;
  } else if (!isBareRepo(target.barePath)) throw new Error(`${target.barePath} exists and is not a bare repository`);
  let createdClone = false;
  if (!fs.existsSync(path.join(publishDir, ".git"))) {
    fs.mkdirSync(publishDir, { recursive: true });
    if (fs.readdirSync(publishDir).length) throw new Error(`${publishDir} is not empty and has no .git; refusing to initialize over it`);
    git(["init", "-q", "-b", cfg.branch], { cwd: publishDir, guard });
    git(["remote", "add", "origin", target.url], { cwd: publishDir, guard });
    createdClone = true;
  }
  configureClone(publishDir, guard);
  return { createdBare, createdClone };
}

function configureClone(publishDir: string, guard: string[]): void {
  for (const [k, v] of [
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.logAllRefUpdates", "false"],
    ["gc.auto", "0"],
    ["core.hooksPath", ".git/hooks-disabled"],
  ])
    git(["config", k, v], { cwd: publishDir, guard });
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`symlink in staged dist: ${p}`);
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

export interface SnapshotResult {
  commit: string;
  tree: string;
  files: number;
}

/** Replace publish/'s content with `stageDir` and make one parentless commit on `branch`; drop all other refs. */
export function snapshotCommit(publishDir: string, stageDir: string, cfg: PublishConfig, guard: string[], message: string, now = new Date()): SnapshotResult {
  configureClone(publishDir, guard);
  for (const e of fs.readdirSync(publishDir)) if (e !== ".git") fs.rmSync(path.join(publishDir, e), { recursive: true, force: true });
  const files = listFiles(stageDir);
  for (const f of files) {
    const dest = path.join(publishDir, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(stageDir, f), dest);
  }
  fs.rmSync(path.join(publishDir, ".git", "index"), { force: true });
  git(["add", "-A", "--force", "."], { cwd: publishDir, guard });
  const tree = gitOut(["write-tree"], { cwd: publishDir, guard });
  const date = `${Math.floor(now.getTime() / 1000)} +0000`;
  const env = {
    GIT_AUTHOR_NAME: cfg.commit_author.name,
    GIT_AUTHOR_EMAIL: cfg.commit_author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: cfg.commit_author.name,
    GIT_COMMITTER_EMAIL: cfg.commit_author.email,
    GIT_COMMITTER_DATE: date,
  };
  const commit = gitOut(["commit-tree", tree, "-m", message], { cwd: publishDir, guard, env });
  const ref = `refs/heads/${cfg.branch}`;
  git(["update-ref", ref, commit], { cwd: publishDir, guard });
  git(["symbolic-ref", "HEAD", ref], { cwd: publishDir, guard });
  for (const r of gitOut(["for-each-ref", "--format=%(refname)"], { cwd: publishDir, guard }).split(/\r?\n/).filter(Boolean)) if (r !== ref) git(["update-ref", "-d", r], { cwd: publishDir, guard });
  git(["reflog", "expire", "--expire=now", "--all"], { cwd: publishDir, guard });
  git(["gc", "--prune=now", "--quiet"], { cwd: publishDir, guard });
  // The index now matches the tree; make the working tree status clean for inspection.
  git(["reset", "-q"], { cwd: publishDir, guard });
  return { commit, tree, files: files.length };
}

/** Force-push the snapshot branch to origin (the ONLY git push in the harness). Returns the remote ref after the push. */
export function pushSnapshot(publishDir: string, cfg: PublishConfig, guard: string[]): { remote_ref: string } {
  const ref = `refs/heads/${cfg.branch}`;
  git(["push", "--force", "--porcelain", "origin", `${ref}:${ref}`], { cwd: publishDir, guard, timeoutMs: 10 * 60_000 });
  const ls = gitOut(["ls-remote", "origin", ref], { cwd: publishDir, guard });
  return { remote_ref: ls.split(/\s+/)[0] ?? "" };
}

export interface ManifestFile {
  path: string;
  sha256: string;
}

export function readManifest(dir: string): ManifestFile[] {
  return (JSON.parse(fs.readFileSync(path.join(dir, "release-manifest.json"), "utf8")) as { files: ManifestFile[] }).files;
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * The staged dist agrees with its own manifest: files = manifest paths + release-manifest.json, hashes equal.
 * Returns problems (empty = consistent).
 */
export function manifestProblems(stageDir: string): string[] {
  const problems: string[] = [];
  let manifest: ManifestFile[];
  try {
    manifest = readManifest(stageDir);
  } catch (e) {
    return [`release-manifest.json unreadable: ${e instanceof Error ? e.message : String(e)}`];
  }
  const files = listFiles(stageDir).filter((f) => f !== "release-manifest.json");
  const want = new Map(manifest.map((m) => [m.path, m.sha256]));
  for (const f of files) {
    const h = want.get(f);
    if (!h) problems.push(`not in manifest: ${f}`);
    else if (h !== sha256(fs.readFileSync(path.join(stageDir, f)))) problems.push(`hash differs from manifest: ${f}`);
  }
  for (const m of manifest) if (!files.includes(m.path)) problems.push(`in manifest but missing: ${m.path}`);
  return problems;
}

export interface BareVerifyReport {
  ok: boolean;
  bare: string;
  branch_commit: string | null;
  expected_commit: string;
  commits_in_history: number;
  refs: string[];
  files_in_repo: number;
  files_expected: number;
  non_site_files: string[];
  missing_files: string[];
  hash_mismatches: string[];
  problems: string[];
}

/** Post-push check against a local bare (gate closed): see module comment. `stageDir` is what was committed. */
export function verifyBare(barePath: string, branch: string, expectedCommit: string, stageDir: string, guard: string[] = []): BareVerifyReport {
  const problems: string[] = [];
  const ref = `refs/heads/${branch}`;
  const head = git(["--git-dir", barePath, "rev-parse", "--verify", "-q", ref], { guard, allowFail: true });
  const branchCommit = head.code === 0 ? head.stdout.trim() : null;
  if (branchCommit !== expectedCommit) problems.push(`${ref} is ${branchCommit ?? "missing"}, expected ${expectedCommit}`);
  const refs = gitOut(["--git-dir", barePath, "for-each-ref", "--format=%(refname)"], { guard }).split(/\r?\n/).filter(Boolean);
  if (refs.length !== 1 || refs[0] !== ref) problems.push(`the repository has refs other than ${ref}: ${refs.join(", ")}`);
  const count = Number(gitOut(["--git-dir", barePath, "rev-list", "--all", "--count"], { guard }));
  if (count !== 1) problems.push(`history has ${count} commits (expected exactly 1)`);
  const tree = branchCommit ? lsTree(barePath, branchCommit, guard) : new Map<string, string>();
  const expected = listFiles(stageDir);
  const manifest = new Map(readManifest(stageDir).map((m) => [m.path, m.sha256]));
  manifest.set("release-manifest.json", sha256(fs.readFileSync(path.join(stageDir, "release-manifest.json"))));
  const nonSite = [...tree.keys()].filter((p) => !manifest.has(p));
  const missing = [...manifest.keys()].filter((p) => !tree.has(p));
  const blobs = readBlobs(barePath, [...new Set(tree.values())], guard);
  const mismatches: string[] = [];
  for (const [p, oid] of tree) {
    const want = manifest.get(p);
    if (want && sha256(blobs.get(oid) ?? Buffer.alloc(0)) !== want) mismatches.push(p);
  }
  if (nonSite.length) problems.push(`files not in the site manifest: ${nonSite.slice(0, 5).join(", ")}${nonSite.length > 5 ? ", …" : ""}`);
  if (missing.length) problems.push(`manifest files missing from the repository: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  if (mismatches.length) problems.push(`sha256 differs from the manifest: ${mismatches.slice(0, 5).join(", ")}`);
  if (tree.size !== expected.length) problems.push(`repository has ${tree.size} files, staged dist has ${expected.length}`);
  return {
    ok: problems.length === 0,
    bare: barePath,
    branch_commit: branchCommit,
    expected_commit: expectedCommit,
    commits_in_history: count,
    refs,
    files_in_repo: tree.size,
    files_expected: expected.length,
    non_site_files: nonSite,
    missing_files: missing,
    hash_mismatches: mismatches,
    problems,
  };
}
