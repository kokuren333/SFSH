/**
 * M5 (7.4 M5, 6.3-8, 6.3-6, CP-041): the remote mix-up check stops the push with a wrong remote, and the production
 * gate (production_enabled: false by default) never lets a push leave for a non-local remote. Temp dirs only; no
 * network (the protocol guard makes git itself refuse network transports; hosts are *.invalid).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { publishSite } from "../src/publish/index.ts";
import { GateClosedError, isNetworkUrl, loadPublishConfig, parsePublishConfig, PROTOCOL_GUARD, resolveTarget, DEFAULT_PUBLISH_CONFIG } from "../src/publish/config.ts";
import { git, gitOut } from "../src/publish/git.ts";
import { checkRemotes } from "../src/publish/repo.ts";
import { publishCommand } from "../src/commands/publish.ts";
import { repoRoot } from "../src/site/stage.ts";
import { bareRef, cleanFixtureDist, cleanupKit, makeKit, putDist, type KitEnv } from "./publishKit.ts";

after(cleanupKit);

async function kitWithDist(over = {}, init = true): Promise<KitEnv> {
  const env = makeKit(over, init);
  putDist(env, await cleanFixtureDist());
  return env;
}

function otherBare(env: KitEnv, name: string): string {
  const p = path.join(env.root, name);
  git(["init", "--bare", "-q", "-b", "main", p]);
  return p;
}

async function expectRemoteBlock(env: KitEnv, re: RegExp, label: string): Promise<void> {
  const before = bareRef(env.barePath);
  const r = await publishSite(env, { trigger: "cli", noBuild: true });
  assert.equal(r.status, "blocked", `${label}: blocked`);
  assert.ok(r.verify?.ok, `${label}: dist itself is clean`);
  assert.ok(r.remote_check && !r.remote_check.ok, `${label}: remote check failed`);
  assert.match(r.remote_check!.problems.join("\n"), re, label);
  assert.equal(r.commit, null, `${label}: no snapshot commit`);
  assert.equal(bareRef(env.barePath), before, `${label}: target bare unchanged`);
  console.log(`# ${label}: blocked — ${r.remote_check!.problems.join(" / ")}`);
}

test("committed publish.json: production gate closed, local test bare, auto mode", () => {
  const cfg = loadPublishConfig(path.join(repoRoot, "harness", "config", "publish.json"));
  assert.equal(cfg.production_enabled, false);
  assert.equal(cfg.remote_url, null);
  assert.equal(cfg.base_url, null);
  assert.equal(cfg.mode, "auto");
  assert.equal(isNetworkUrl(cfg.test_remote_url), false);
  const t = resolveTarget(cfg, repoRoot);
  assert.equal(t.kind, "test");
  assert.deepEqual(t.gitGuard, PROTOCOL_GUARD);
  // The harness repository has no remote (U-06: local git only).
  assert.equal(gitOut(["remote"], { cwd: repoRoot }), "");
});

test("gate closed: non-local remotes are refused before any git command; network transports refused by git itself", async () => {
  for (const u of ["https://github.com/example/site.git", "http://sfsh-gate.invalid/x.git", "git@github.com:example/site.git", "ssh://git@github.com/example/site.git", "github.com:example/site.git", "git://sfsh-gate.invalid/x"]) {
    assert.equal(isNetworkUrl(u), true, u);
    assert.throws(() => resolveTarget(parsePublishConfig({ test_remote_url: u }), repoRoot), GateClosedError, u);
  }
  for (const u of ["publish-test/site.git", "C:\\tmp\\site.git", "C:/tmp/site.git", "/tmp/site.git", "file:///C:/tmp/site.git"]) assert.equal(isNetworkUrl(u), false, u);
  // Pointing the test remote at the harness repository itself is refused.
  assert.throws(() => resolveTarget(parsePublishConfig({ test_remote_url: "." }), repoRoot), GateClosedError);
  assert.throws(() => resolveTarget(parsePublishConfig({ test_remote_url: ".git" }), repoRoot), GateClosedError);
  // remote_url is ignored while the gate is closed.
  const t = resolveTarget(parsePublishConfig({ remote_url: "https://github.com/example/site.git" }), repoRoot);
  assert.equal(t.kind, "test");
  // publishSite with a network test remote: blocked with no target, nothing built or pushed.
  const env = await kitWithDist({}, false);
  env.config = parsePublishConfig({ ...env.config, test_remote_url: "https://github.com/example/site.git" });
  const r = await publishSite(env, { trigger: "cli" });
  assert.equal(r.status, "blocked");
  assert.equal(r.target, null);
  assert.match(r.error ?? "", /production gate is closed/);
  assert.equal(r.verify, null);
  // The protocol guard: git refuses https / ssh transports outright (no connection is attempted).
  for (const u of ["https://sfsh-gate.invalid/x.git", "ssh://git@sfsh-gate.invalid/x.git"]) {
    const g = git(["ls-remote", u], { guard: PROTOCOL_GUARD, allowFail: true, timeoutMs: 20_000 });
    assert.notEqual(g.code, 0);
    assert.match(g.stderr, /transport '(https|ssh)' not allowed/, g.stderr);
  }
});

test("gate closed: publish/ whose origin was re-pointed at a network URL is stopped by the remote check (no push)", async () => {
  const env = await kitWithDist();
  git(["remote", "set-url", "origin", "https://github.com/example/site.git"], { cwd: env.publishDir });
  await expectRemoteBlock(env, /origin URL "https:\/\/github\.com\/example\/site\.git" does not match/, "origin → GitHub while gate closed");
});

test("remote mix-up check stops the push: wrong bare, extra remote, push URL, insteadOf, harness-side remote, not its own repo", async () => {
  // 1) origin points at another (wrong) bare
  let env = await kitWithDist();
  git(["remote", "set-url", "origin", otherBare(env, "wrong.git")], { cwd: env.publishDir });
  await expectRemoteBlock(env, /does not match the configured target/, "origin = wrong bare");
  assert.equal(bareRef(path.join(env.root, "wrong.git")), null, "the wrong bare received nothing");

  // 2) an extra remote
  env = await kitWithDist();
  git(["remote", "add", "upstream", otherBare(env, "up.git")], { cwd: env.publishDir });
  await expectRemoteBlock(env, /exactly one remote "origin"/, "extra remote");

  // 3) fetch URL right, push URL wrong
  env = await kitWithDist();
  git(["remote", "set-url", "--push", "origin", otherBare(env, "push.git")], { cwd: env.publishDir });
  await expectRemoteBlock(env, /does not match the configured target/, "pushurl differs");
  assert.equal(bareRef(path.join(env.root, "push.git")), null);

  // 4) url.<x>.insteadOf rewrites the target to somewhere else
  env = await kitWithDist();
  const sneaky = otherBare(env, "sneaky.git");
  git(["config", `url.${sneaky.replace(/\\/g, "/")}.insteadOf`, env.barePath.replace(/\\/g, "/")], { cwd: env.publishDir });
  git(["remote", "set-url", "origin", env.barePath.replace(/\\/g, "/")], { cwd: env.publishDir });
  await expectRemoteBlock(env, /does not match the configured target/, "insteadOf rewrite");
  assert.equal(bareRef(sneaky), null);

  // 5) the harness repository registers the Pages target as a remote
  env = await kitWithDist();
  git(["remote", "add", "pages", env.barePath], { cwd: env.root });
  await expectRemoteBlock(env, /the harness repository has remote "pages" = the Pages target/, "harness-side Pages remote");

  // 6) publish/ origin equals a harness-side remote (and the config target is that same URL)
  env = await kitWithDist();
  const shared = otherBare(env, "shared.git");
  git(["remote", "add", "backup", shared], { cwd: env.root });
  env.config = parsePublishConfig({ ...env.config, test_remote_url: shared });
  git(["remote", "set-url", "origin", shared], { cwd: env.publishDir });
  await expectRemoteBlock(env, /harness repository has remote "backup"|publish\/ origin equals harness remote/, "origin = harness remote");
  assert.equal(bareRef(shared), null);

  // 7) publish/ is not its own repository (its .git removed: it would resolve to the harness repository)
  env = await kitWithDist();
  fs.rmSync(path.join(env.publishDir, ".git"), { recursive: true, force: true });
  await expectRemoteBlock(env, /not its own git repository/, "publish/ inside the harness repo");

  // 8) the configured test target is not a bare repository
  env = await kitWithDist();
  const notBare = path.join(env.root, "plain");
  git(["init", "-q", notBare]);
  env.config = parsePublishConfig({ ...env.config, test_remote_url: notBare });
  git(["remote", "set-url", "origin", notBare], { cwd: env.publishDir });
  await expectRemoteBlock(env, /not an existing bare repository/, "target not bare");
});

test("the correct setup passes the remote check (control)", async () => {
  const env = await kitWithDist();
  const chk = checkRemotes(env.publishDir, resolveTarget(env.config, env.root), env.root);
  assert.ok(chk.ok, chk.problems.join("; "));
  const r = await publishSite(env, { trigger: "cli", noBuild: true, dryRun: true });
  assert.equal(r.status, "dry_run");
  assert.equal(bareRef(env.barePath), null, "dry run pushes nothing");
});

test("gate open (production_enabled: true): remote_url required; the production path pushes to remote_url only", async () => {
  assert.throws(() => resolveTarget(parsePublishConfig({ production_enabled: true }), repoRoot), GateClosedError);
  // Exercise the production code path against a local bare standing in for the real repository.
  const env = await kitWithDist({}, false);
  const prod = otherBare(env, "prod.git");
  env.config = parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, production_enabled: true, remote_url: prod, url_check: { timeout_s: 0, interval_s: 1 } });
  const t = resolveTarget(env.config, env.root);
  assert.equal(t.kind, "production");
  assert.deepEqual(t.gitGuard, []);
  // init refuses when the gate is open (the real repository is set up by the opening procedure).
  const errs: string[] = [];
  const e0 = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    assert.equal(await publishCommand(["init"], env), 2);
  } finally {
    console.error = e0;
  }
  assert.match(errs.join("\n"), /gate is open/);
  // Opening procedure stand-in: publish/ with origin = remote_url.
  fs.mkdirSync(env.publishDir, { recursive: true });
  git(["init", "-q", "-b", "main"], { cwd: env.publishDir });
  git(["remote", "add", "origin", prod], { cwd: env.publishDir });
  const r = await publishSite(env, { trigger: "cli", noBuild: true });
  assert.equal(r.status, "pushed", r.error ?? "");
  assert.equal(r.target?.kind, "production");
  assert.equal(bareRef(prod), r.commit);
  assert.equal(r.post_verify.url_note, "skipped: base_url is not set in harness/config/publish.json");
});

test("only harness/src/publish/repo.ts runs git push (no other code path can push)", () => {
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        // Code lines only (comments may mention pushing): a git argv starting with "push", or a "git push" command string.
        const code = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
        if (/\[\s*["'`]push["'`]/.test(code) || /["'`][^"'`\n]*\bgit\s+push\b/.test(code)) offenders.push(path.relative(repoRoot, p).replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join(repoRoot, "harness", "src"));
  walk(path.join(repoRoot, "site", "src"));
  assert.deepEqual(offenders, ["harness/src/publish/repo.ts"]);
});
