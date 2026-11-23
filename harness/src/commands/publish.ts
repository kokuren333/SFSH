/**
 * `sfsh publish …` (WP-5.1 / 5.2; PLAN §2).
 *
 *   sfsh publish [--no-build] [--dry-run] [--reason <t>] [--json]   build → verify (a)–(g) → remote check → snapshot → push → post-verify
 *   sfsh publish init [--json]                                      gate closed: create the local test bare + publish/ (origin = bare)
 *   sfsh publish status [--json]                                    gate, target, publish/ remotes, remote check, last release
 *   sfsh publish verify-url [--base-url <u>] [--json]               compare every manifest file at the URL (gate closed: loopback only)
 *   sfsh publish serve-test [--port <n>]                            local Pages stand-in over the test bare (127.0.0.1)
 *
 * Exit: 0 ok / 2 usage, configuration or closed gate / 3 blocked (verification / remote check) or failed.
 */
import fs from "node:fs";
import path from "node:path";
import { loadPublishConfig, resolveTarget, GateClosedError, PublishConfigError, type PublishConfig } from "../publish/config.ts";
import { defaultPublishEnv, previousSnapshot, publishInitialized, publishSite, type PublishEnv, type PublishResult } from "../publish/index.ts";
import { checkRemotes, initPublishRepo, readManifest, sha256 } from "../publish/repo.ts";
import { servePagesFromBare, verifyUrl } from "../publish/url.ts";

function value(args: string[], i: number): string | undefined {
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

function printPublish(r: PublishResult): void {
  console.log(`publish ${r.release_id}: ${r.status.toUpperCase()} (target ${r.target ? `${r.target.kind} ${r.target.url}` : "-"}; ${r.elapsed_ms} ms)`);
  if (r.verify) {
    const c = r.verify.checks;
    console.log(`  verify: ${r.verify.files} files, ${r.verify.bytes} bytes, public works ${r.verify.public_set.length} → ${r.verify.ok ? "ok" : "BLOCKED"} [${(Object.keys(c) as (keyof typeof c)[]).map((k) => `${k}:${c[k].ok ? "ok" : c[k].findings}`).join(" ")}]`);
    for (const f of r.verify.blocking.slice(0, 20)) console.log(`    (${f.check}) ${f.kind} ${f.file ?? ""} — ${f.detail}`);
    if (r.verify.blocking.length > 20) console.log(`    … ${r.verify.blocking.length - 20} more (see ${r.record_path})`);
    for (const f of r.verify.warnings) console.log(`    warning (${f.check}) ${f.kind}: ${f.detail}`);
  }
  for (const p of r.manifest_problems) console.log(`  manifest: ${p}`);
  if (r.remote_check) console.log(`  remote check (6.3-8): ${r.remote_check.ok ? "ok" : "FAILED"}${r.remote_check.problems.map((p) => `\n    ${p}`).join("")}`);
  if (r.commit) console.log(`  snapshot commit ${r.commit} → remote ${r.remote_ref}`);
  const b = r.post_verify.bare;
  if (b) console.log(`  post-push (bare): ${b.ok ? "ok" : "FAILED"} — ${b.commits_in_history} commit(s), refs ${b.refs.join(",")}, ${b.files_in_repo}/${b.files_expected} files, non-site ${b.non_site_files.length}, sha256 mismatches ${b.hash_mismatches.length}`);
  const u = r.post_verify.url;
  if (u) console.log(`  post-push (URL): ${u.ok ? "ok" : "FAILED"} — ${u.checked} files at ${u.base_url} (${r.post_verify.url_note})`);
  else if (r.post_verify.url_note) console.log(`  post-push (URL): ${r.post_verify.url_note}`);
  if (r.url_404) console.log(`  404 check: ${r.url_404.ok ? "ok" : "FAILED"} — ${r.url_404.url} → ${r.url_404.status}`);
  const changed = r.works.filter((w) => w.changed);
  if (r.works.length) console.log(`  releases: ${changed.length ? changed.map((w) => w.work_id).join(", ") : "(no work changed)"}`);
  if (Object.keys(r.timings_ms).length) console.log(`  timings: ${Object.entries(r.timings_ms).map(([k, v]) => `${k} ${v}ms`).join(", ")}`);
  if (r.error) console.log(`  error: ${r.error}`);
  console.log(`  record: ${r.record_path}`);
}

function loadCfg(): PublishConfig | number {
  try {
    return loadPublishConfig();
  } catch (e) {
    console.error(`sfsh publish: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

/** node --test sets NODE_TEST_CONTEXT in test processes: the default (real repository) env must never run there. */
function refuseUnderTestRunner(envIn?: PublishEnv): boolean {
  if (envIn || !process.env.NODE_TEST_CONTEXT || process.env.SFSH_ALLOW_REAL_PUBLISH_IN_TESTS === "1") return false;
  console.error("sfsh publish: refusing to run against the real repository under the test runner (pass a temp PublishEnv)");
  return true;
}

export async function publishCommand(args: string[], envIn?: PublishEnv): Promise<number> {
  if (refuseUnderTestRunner(envIn)) return 2;
  const [sub] = args;
  if (sub === "init" || sub === "status" || sub === "verify-url" || sub === "serve-test") return subcommand(sub, args.slice(1), envIn);
  let noBuild = false;
  let dryRun = false;
  let json = false;
  let reason: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-build") noBuild = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--reason" && value(args, i) !== undefined) reason = args[++i];
    else {
      console.error(`unknown argument: ${a}\nusage: sfsh publish [--no-build] [--dry-run] [--reason <t>] [--json] | init | status | verify-url [--base-url <u>] | serve-test [--port <n>]`);
      return 2;
    }
  }
  let env = envIn;
  if (!env) {
    const cfg = loadCfg();
    if (typeof cfg === "number") return cfg;
    env = defaultPublishEnv(cfg);
  }
  const r = await publishSite(env, { noBuild, dryRun, reason, trigger: "cli" });
  if (json) console.log(JSON.stringify(r, null, 2));
  else printPublish(r);
  if (r.status === "pushed" || r.status === "dry_run") return 0;
  return r.target === null ? 2 : 3;
}

async function subcommand(sub: string, args: string[], envIn?: PublishEnv): Promise<number> {
  const json = args.includes("--json");
  let env = envIn;
  if (!env) {
    const cfg = loadCfg();
    if (typeof cfg === "number") return cfg;
    env = defaultPublishEnv(cfg);
  }
  let target;
  try {
    target = resolveTarget(env.config, env.repoRoot);
  } catch (e) {
    if (e instanceof GateClosedError || e instanceof PublishConfigError) {
      console.error(`sfsh publish ${sub}: ${e.message}`);
      return 2;
    }
    throw e;
  }

  if (sub === "init") {
    if (target.kind !== "test") {
      console.error("sfsh publish init: the production gate is open; publish/ for the real repository is set up by the opening procedure (design/SITE_OPENING.md), not by init");
      return 2;
    }
    const r = initPublishRepo(env.publishDir, target, env.config, env.repoRoot);
    const chk = checkRemotes(env.publishDir, target, env.repoRoot);
    const out = { ...r, bare: target.barePath, publish_dir: env.publishDir, remote_check: chk };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`test bare: ${target.barePath} (${r.createdBare ? "created" : "exists"})`);
      console.log(`publish/: ${env.publishDir} (${r.createdClone ? "created" : "exists"}), origin = ${target.url}`);
      console.log(`remote check (6.3-8): ${chk.ok ? "ok" : "FAILED"}${chk.problems.map((p) => `\n  ${p}`).join("")}`);
    }
    return chk.ok ? 0 : 3;
  }

  if (sub === "status") {
    const chk = publishInitialized(env) ? checkRemotes(env.publishDir, target, env.repoRoot) : null;
    const prev = previousSnapshot(env.logDir);
    const out = {
      production_enabled: env.config.production_enabled,
      mode: env.config.mode,
      target: { kind: target.kind, url: target.url, base_url: target.baseUrl },
      publish_initialized: publishInitialized(env),
      remote_check: chk,
      last_pushed: prev,
      worker_auto_publish: env.config.production_enabled && env.config.mode === "auto",
    };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`production gate: ${env.config.production_enabled ? "OPEN" : "closed (only the local test bare is a push target)"}; mode ${env.config.mode}; worker auto-publish ${out.worker_auto_publish ? "on" : "off (jobs stop at built)"}`);
      console.log(`target: ${target.kind} ${target.url}${target.baseUrl ? ` (base_url ${target.baseUrl})` : ""}`);
      console.log(`publish/: ${out.publish_initialized ? env.publishDir : "not initialized (sfsh publish init)"}`);
      if (chk) console.log(`remote check (6.3-8): ${chk.ok ? "ok" : "FAILED"}${chk.problems.map((p) => `\n  ${p}`).join("")}`);
      console.log(`last pushed: ${prev ? `${prev.release_id} (${prev.files} files, ${prev.bytes} bytes)` : "none"}`);
    }
    return 0;
  }

  if (sub === "verify-url") {
    let base: string | null = target.baseUrl;
    for (let i = 0; i < args.length; i++) if (args[i] === "--base-url" && value(args, i)) base = args[++i]!;
    if (!base) {
      console.error("sfsh publish verify-url: no base URL (set base_url in harness/config/publish.json or pass --base-url)");
      return 2;
    }
    const dir = env.stageDir && fs.existsSync(path.join(env.stageDir, "release-manifest.json")) ? env.stageDir : env.distDir;
    try {
      const manifest = readManifest(dir);
      const self = { sha256: sha256(fs.readFileSync(path.join(dir, "release-manifest.json"))) };
      const r = await verifyUrl(base, manifest, self, {
        loopbackOnly: !env.config.production_enabled,
        timeoutMs: env.config.url_check.timeout_s * 1000,
        intervalMs: env.config.url_check.interval_s * 1000,
      });
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(`verify-url ${r.base_url}: ${r.ok ? "ok" : "FAILED"} — ${r.checked} files, missing ${r.missing.length}, mismatched ${r.mismatched.length}, attempts ${r.attempts}, ${r.elapsed_ms} ms${[...r.missing, ...r.mismatched].slice(0, 10).map((x) => `\n  ${x}`).join("")}`);
      return r.ok ? 0 : 3;
    } catch (e) {
      console.error(`sfsh publish verify-url: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }

  // serve-test
  if (target.kind !== "test" || !target.barePath) {
    console.error("sfsh publish serve-test: only while the production gate is closed (serves the local test bare)");
    return 2;
  }
  let port = 8790;
  for (let i = 0; i < args.length; i++) if (args[i] === "--port" && value(args, i)) port = Number(args[++i]);
  const srv = await servePagesFromBare(target.barePath, env.config.branch, port);
  console.log(`Pages stand-in over ${target.barePath} (${env.config.branch}): ${srv.url}`);
  const stop = () => void srv.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return 0;
}
