/**
 * S6 publish (REQUIREMENTS §6.3, §5.3, §5.4; WP-5.1 / 5.2 / 5.3; PLAN §2).
 *
 * publishSite(): [build] → stage a copy of dist (under the build lock) → push-pre verification (a)–(g) + manifest
 * consistency → remote mix-up check (6.3-8) → snapshot commit (one parentless commit) → force push → post-push
 * verification (gate closed: the local bare + the Pages stand-in; open: the public URL) → [takedown: 404 check] →
 * records (logs/publish/<release_id>.json, works/<id>/releases/<release_id>.json for changed works, one ledger line).
 * Nothing touches publish/ unless the verification and the remote check pass.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isoLocal } from "../model/callLog.ts";
import { paths } from "../paths.ts";
import { appendRawLedgerLine } from "../works/ops.ts";
import { PUBLISHED_COPY, savePublishedCopy } from "../check/conformance.ts";
import { verifyDist, type VerifyReport } from "./verify.ts";
import { loadPublishConfig, resolveTarget, GateClosedError, type PublishConfig, type PublishTarget } from "./config.ts";
import { withDirLock } from "./lock.ts";
import {
  checkRemotes,
  manifestProblems,
  pushSnapshot,
  readManifest,
  sha256,
  snapshotCommit,
  verifyBare,
  type BareVerifyReport,
  type RemoteCheckReport,
} from "./repo.ts";
import { check404, servePagesFromBare, verifyUrl, type Url404Report, type UrlVerifyReport } from "./url.ts";

export interface PublishEnv {
  repoRoot: string;
  worksDir: string;
  /** site/dist (the build output that is published). */
  distDir: string;
  /** publish/ (the Pages-side working clone). */
  publishDir: string;
  /** Private staging copy of dist that is verified and committed (site/.publish-stage). */
  stageDir: string;
  /** logs/publish (one record per run). */
  logDir: string;
  ledgerPath: string;
  callLogDir: string;
  lockDir: string;
  config: PublishConfig;
  build?: (o: { worksDir: string; out: string; baseUrl?: string }) => Promise<unknown>;
  now?: () => Date;
  /** Override the build lock used while copying dist (tests). Default: site/build.ts acquireBuildLock. */
  acquireBuildLock?: () => Promise<() => Promise<void>>;
  /** Production URL checks (tests inject a fetch). */
  fetchImpl?: typeof fetch;
}

export function defaultPublishEnv(config: PublishConfig = loadPublishConfig()): PublishEnv {
  return {
    repoRoot: paths.root,
    worksDir: paths.works,
    distDir: path.join(paths.root, "site", "dist"),
    publishDir: path.join(paths.root, "publish"),
    stageDir: path.join(paths.root, "site", ".publish-stage"),
    logDir: path.join(paths.root, "logs", "publish"),
    ledgerPath: path.join(paths.root, "logs", "LEDGER.md"),
    callLogDir: paths.callLogDir,
    lockDir: path.join(paths.root, "site", ".publish.lock"),
    config,
  };
}

export interface PublishOptions {
  /** Use the existing distDir as is (takedown has just rebuilt it). */
  noBuild?: boolean;
  /** Verify + remote check only; no commit, no push. */
  dryRun?: boolean;
  trigger: "cli" | "worker" | "takedown" | "purge";
  reason?: string;
  actor?: string;
  /** takedown / purge: the work that must be gone (404 check + needles for the catalog). */
  takedown?: { workId: string; needles: string[] };
}

export type PublishStatus = "pushed" | "dry_run" | "blocked" | "failed";

export interface WorkRelease {
  work_id: string;
  content_hash: string;
  files: number;
  changed: boolean;
  record: string | null;
}

export interface PublishResult {
  schema: "sfsh-publish/1";
  release_id: string;
  status: PublishStatus;
  trigger: PublishOptions["trigger"];
  actor: string;
  reason: string | null;
  started_at: string;
  target: { kind: PublishTarget["kind"]; url: string; base_url: string | null } | null;
  gate: { production_enabled: boolean };
  build: unknown;
  verify: VerifyReport | null;
  manifest_problems: string[];
  remote_check: RemoteCheckReport | null;
  commit: string | null;
  remote_ref: string | null;
  post_verify: { bare: BareVerifyReport | null; url: UrlVerifyReport | null; url_note: string | null };
  url_404: Url404Report | null;
  url_404_note: string | null;
  works: WorkRelease[];
  timings_ms: Record<string, number>;
  elapsed_ms: number;
  error: string | null;
  record_path: string | null;
  ledger_line: string | null;
}

function releaseIdOf(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, errorOnExist: false, verbatimSymlinks: true });
}

function dirSize(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(root);
  return { files, bytes };
}

/** Size of the last pushed snapshot (for (f)), from logs/publish records. */
export function previousSnapshot(logDir: string): { files: number; bytes: number; release_id: string } | null {
  if (!fs.existsSync(logDir)) return null;
  const names = fs.readdirSync(logDir).filter((n) => /^\d{8}-\d{9}\.json$/.test(n)).sort().reverse();
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(logDir, n), "utf8")) as PublishResult;
      if (r.status === "pushed" && r.verify) return { files: r.verify.files, bytes: r.verify.bytes, release_id: r.release_id };
    } catch {
      /* skip unreadable */
    }
  }
  return null;
}

function modelIdsForJob(callLogDir: string, jobId: string | null): string[] {
  if (!jobId || !fs.existsSync(callLogDir)) return [];
  const ids = new Set<string>();
  const needle = `"jobId":"${jobId}"`;
  for (const n of fs.readdirSync(callLogDir).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(callLogDir, n), "utf8").split("\n")) {
      if (!line.includes(needle)) continue;
      try {
        const m = (JSON.parse(line) as { modelId?: string }).modelId;
        if (m) ids.add(m);
      } catch {
        /* skip */
      }
    }
  }
  return [...ids].sort();
}

function latestRelease(dir: string): { content_hash?: string; release_id?: string } | null {
  if (!fs.existsSync(dir)) return null;
  // release records only (<release_id>.json); A15 keeps published.public.json / published.meta.json beside them
  const n = fs.readdirSync(dir).filter((x) => /^\d{8}-\d+(?:-\d+)?\.json$/.test(x)).sort().pop();
  if (!n) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { content_hash?: string; release_id?: string };
  } catch {
    return null;
  }
}

/** Per-work release records for works whose published files changed (§5.3: content hash, model ids, advisory count, time). */
function writeWorkReleases(env: PublishEnv, releaseId: string, at: Date, commit: string, target: PublishTarget, publicSet: string[]): WorkRelease[] {
  const manifest = readManifest(env.stageDir);
  const out: WorkRelease[] = [];
  for (const id of publicSet) {
    const files = manifest.filter((m) => m.path.startsWith(`works/${id}/`)).sort((a, b) => (a.path < b.path ? -1 : 1));
    const contentHash = "sha256:" + sha256(files.map((f) => `${f.path}\t${f.sha256}\n`).join(""));
    const relDir = path.join(env.worksDir, id, "releases");
    const prev = latestRelease(relDir);
    const changed = prev?.content_hash !== contentHash;
    let record: string | null = null;
    if (changed) {
      let report: { job_id?: string; advisory?: unknown[]; advisory_counts?: Record<string, number> } = {};
      try {
        report = JSON.parse(fs.readFileSync(path.join(env.worksDir, id, "check", "report.json"), "utf8"));
      } catch {
        /* no S4 report */
      }
      fs.mkdirSync(relDir, { recursive: true });
      record = path.join(relDir, `${releaseId}.json`);
      const rec = {
        schema: "sfsh-release/1",
        release_id: releaseId,
        work_id: id,
        published_at: isoLocal(at),
        target_kind: target.kind,
        commit,
        content_hash: contentHash,
        files: files.length,
        check_job_id: report.job_id ?? null,
        model_ids: modelIdsForJob(env.callLogDir, report.job_id ?? null),
        advisory_count: Array.isArray(report.advisory) ? report.advisory.length : null,
        advisory_counts: report.advisory_counts ?? null,
        previous_content_hash: prev?.content_hash ?? null,
        // AMENDMENT 15: the published public.json is kept as the baseline of the next regression check
        public_copy: null as string | null,
        shape: null as unknown,
      };
      try {
        const shape = savePublishedCopy(path.join(env.worksDir, id), releaseId, at);
        if (shape) {
          rec.public_copy = PUBLISHED_COPY;
          rec.shape = { elements: shape.elements, figures: shape.figures, synopsis: shape.synopsis };
        }
      } catch {
        /* the copy is a convenience for the regression check; the publish itself is done */
      }
      fs.writeFileSync(record, JSON.stringify(rec, null, 2) + "\n", "utf8");
    } else if (!fs.existsSync(path.join(env.worksDir, id, PUBLISHED_COPY))) {
      // AMENDMENT 15 bootstrap: unchanged since the last release (same content hash) → gen/public.json is what is online
      try {
        savePublishedCopy(path.join(env.worksDir, id), prev?.release_id ?? releaseId, at, "bootstrap: unchanged since the last release");
      } catch {
        /* see above */
      }
    }
    out.push({ work_id: id, content_hash: contentHash, files: files.length, changed, record: record ? path.relative(env.repoRoot, record).replace(/\\/g, "/") : null });
  }
  return out;
}

export class PublishError extends Error {
  readonly result: PublishResult;
  constructor(msg: string, result: PublishResult) {
    super(msg);
    this.name = "PublishError";
    this.result = result;
  }
}

/** Run one publish. Never throws for blocked/failed runs: the status says what happened (records are always written). */
export async function publishSite(env: PublishEnv, opts: PublishOptions): Promise<PublishResult> {
  const t0 = performance.now();
  const now = env.now ?? (() => new Date());
  const startedAt = now();
  const cfg = env.config;
  const result: PublishResult = {
    schema: "sfsh-publish/1",
    release_id: releaseIdOf(startedAt),
    status: "failed",
    trigger: opts.trigger,
    actor: opts.actor ?? "owner(cli)",
    reason: opts.reason?.trim() || null,
    started_at: isoLocal(startedAt),
    target: null,
    gate: { production_enabled: cfg.production_enabled },
    build: null,
    verify: null,
    manifest_problems: [],
    remote_check: null,
    commit: null,
    remote_ref: null,
    post_verify: { bare: null, url: null, url_note: null },
    url_404: null,
    url_404_note: null,
    works: [],
    timings_ms: {},
    elapsed_ms: 0,
    error: null,
    record_path: null,
    ledger_line: null,
  };
  const lap = (k: string, from: number) => (result.timings_ms[k] = Math.round(performance.now() - from));

  let target: PublishTarget;
  try {
    target = resolveTarget(cfg, env.repoRoot);
  } catch (e) {
    result.status = "blocked";
    result.error = e instanceof Error ? e.message : String(e);
    return finish(env, result, t0);
  }
  result.target = { kind: target.kind, url: target.url, base_url: target.baseUrl };

  try {
    await withDirLock(env.lockDir, async () => {
      // 1) build
      if (!opts.noBuild) {
        const tb = performance.now();
        const build = env.build ?? (await import("../site/build.ts")).build;
        result.build = await build({ worksDir: env.worksDir, out: env.distDir, baseUrl: target.baseUrl ?? undefined });
        lap("build", tb);
      }
      // 2) stage an immutable copy of dist (a concurrent worker build cannot change what we verify and commit)
      const ts = performance.now();
      const acquire = env.acquireBuildLock ?? (await import("../site/build.ts")).acquireBuildLock;
      const release = await acquire();
      try {
        if (!fs.existsSync(path.join(env.distDir, "release-manifest.json"))) throw new Error(`${env.distDir} has no build (release-manifest.json missing)`);
        copyDir(env.distDir, env.stageDir);
      } finally {
        await release();
      }
      lap("stage", ts);
      // 3) push-pre verification (a)–(g) + manifest consistency
      const tv = performance.now();
      const prev = previousSnapshot(env.logDir);
      result.verify = verifyDist({ distDir: env.stageDir, worksDir: env.worksDir, previous: prev, allowEmails: cfg.allow_emails, now });
      result.manifest_problems = manifestProblems(env.stageDir);
      lap("verify", tv);
      if (!result.verify.ok || result.manifest_problems.length) {
        result.status = "blocked";
        const b = result.verify.blocking;
        result.error = `push-pre verification failed: ${b.length} blocking finding(s)${b.length ? ` (${[...new Set(b.map((x) => `(${x.check}) ${x.kind}`))].slice(0, 6).join(", ")})` : ""}${result.manifest_problems.length ? `; manifest: ${result.manifest_problems.slice(0, 3).join(", ")}` : ""}`;
        return;
      }
      // 4) remote mix-up check
      const tr = performance.now();
      result.remote_check = checkRemotes(env.publishDir, target, env.repoRoot);
      lap("remote_check", tr);
      if (!result.remote_check.ok) {
        result.status = "blocked";
        result.error = `remote mix-up check failed (6.3-8): ${result.remote_check.problems.join("; ")}`;
        return;
      }
      if (opts.dryRun) {
        result.status = "dry_run";
        return;
      }
      // 5) snapshot commit + 6) push
      const tc = performance.now();
      const msg = `SFSH snapshot ${result.release_id}\n\nfiles: ${result.verify.files}, bytes: ${result.verify.bytes}, works: ${result.verify.public_set.length}\nrelease-manifest.json sha256: ${sha256(fs.readFileSync(path.join(env.stageDir, "release-manifest.json")))}`;
      const snap = snapshotCommit(env.publishDir, env.stageDir, cfg, target.gitGuard, msg, startedAt);
      result.commit = snap.commit;
      lap("snapshot", tc);
      const tp = performance.now();
      result.remote_ref = pushSnapshot(env.publishDir, cfg, target.gitGuard).remote_ref;
      lap("push", tp);
      if (result.remote_ref !== snap.commit) throw new Error(`remote ${cfg.branch} is ${result.remote_ref || "missing"} after push, expected ${snap.commit}`);
      // 7) post-push verification
      const tq = performance.now();
      const manifest = readManifest(env.stageDir);
      const self = { sha256: sha256(fs.readFileSync(path.join(env.stageDir, "release-manifest.json"))) };
      if (target.kind === "test") {
        result.post_verify.bare = verifyBare(target.barePath!, cfg.branch, snap.commit, env.stageDir, target.gitGuard);
        const srv = await servePagesFromBare(target.barePath!, cfg.branch);
        try {
          result.post_verify.url = await verifyUrl(srv.url, manifest, self, { loopbackOnly: true, timeoutMs: 0 });
          result.post_verify.url_note = `local Pages stand-in over the test bare (${srv.url})`;
          if (opts.takedown) {
            result.url_404 = await check404(srv.url, opts.takedown.workId, opts.takedown.needles, { loopbackOnly: true, timeoutMs: 0 });
            result.url_404_note = `local Pages stand-in over the test bare (the real public URL check comes after the site opening, U-05)`;
          }
        } finally {
          await srv.close();
        }
      } else if (target.baseUrl) {
        const uo = { loopbackOnly: false, timeoutMs: cfg.url_check.timeout_s * 1000, intervalMs: cfg.url_check.interval_s * 1000, fetchImpl: env.fetchImpl };
        // M6: wait for the Pages deploy (cache-busted manifest = the new one) before the canonical URLs are requested.
        result.post_verify.url = await verifyUrl(target.baseUrl, manifest, self, { ...uo, deploySentinel: { sha256: self.sha256, tag: result.release_id } });
        const dw = result.post_verify.url.deploy;
        result.post_verify.url_note = `public URL${dw ? ` (deploy ${dw.ok ? "observed" : "NOT observed"} after ${Math.round(dw.waited_ms / 1000)}s, ${dw.polls} polls)` : ""}`;
        if (opts.takedown) {
          result.url_404 = await check404(target.baseUrl, opts.takedown.workId, opts.takedown.needles, uo);
          result.url_404_note = "public URL";
        }
      } else {
        result.post_verify.url_note = "skipped: base_url is not set in harness/config/publish.json";
        if (opts.takedown) result.url_404_note = "skipped: base_url is not set";
      }
      lap("post_verify", tq);
      // 8) per-work release records
      result.works = writeWorkReleases(env, result.release_id, startedAt, snap.commit, target, result.verify.public_set);
      const pv = result.post_verify;
      const postOk = (pv.bare ? pv.bare.ok : true) && (pv.url ? pv.url.ok : true) && (result.url_404 ? result.url_404.ok : true);
      result.status = postOk ? "pushed" : "failed";
      if (!postOk)
        result.error = `post-push verification failed: ${[...(pv.bare?.problems ?? []), ...(pv.url && !pv.url.ok ? [`url: ${pv.url.missing.length} missing, ${pv.url.mismatched.length} mismatched`] : []), ...(result.url_404 && !result.url_404.ok ? [`404 check: status ${result.url_404.status}, catalog mentions ${result.url_404.catalog_mentions.join(",")}`] : [])].join("; ")}`;
    });
  } catch (e) {
    result.status = "failed";
    result.error = e instanceof Error ? e.message : String(e);
  }
  return finish(env, result, t0);
}

function finish(env: PublishEnv, result: PublishResult, t0: number): PublishResult {
  result.elapsed_ms = Math.round(performance.now() - t0);
  fs.mkdirSync(env.logDir, { recursive: true });
  const rec = path.join(env.logDir, `${result.release_id}.json`);
  result.record_path = path.relative(env.repoRoot, rec).replace(/\\/g, "/");
  const v = result.verify;
  const parts = [
    `release=${result.release_id}`,
    `status=${result.status}`,
    `trigger=${result.trigger}`,
    `actor=${result.actor}`,
    `target=${result.target ? `${result.target.kind}` : "-"}`,
    result.commit ? `commit=${result.commit.slice(0, 12)}` : "",
    v ? `files=${v.files} bytes=${v.bytes} works=${v.public_set.length} verify=${v.ok ? "ok" : `blocked(${v.blocking.length})`} warnings=${v.warnings.length}` : "",
    result.remote_check ? `remote_check=${result.remote_check.ok ? "ok" : "failed"}` : "",
    result.post_verify.bare ? `bare=${result.post_verify.bare.ok ? "ok" : "failed"}(commits=${result.post_verify.bare.commits_in_history},files=${result.post_verify.bare.files_in_repo})` : "",
    result.post_verify.url ? `url=${result.post_verify.url.ok ? "ok" : "failed"}(${result.post_verify.url.checked})` : "",
    result.url_404 ? `404=${result.url_404.ok ? "ok" : "failed"}(${result.url_404.status})` : "",
    result.works.length ? `releases=${result.works.filter((w) => w.changed).map((w) => w.work_id).join(",") || "none-changed"}` : "",
    `${result.elapsed_ms}ms`,
    result.error ? `error=${result.error.replace(/\s+/g, " ").slice(0, 300)}` : "",
    `record=${result.record_path}`,
  ].filter(Boolean);
  result.ledger_line = appendRawLedgerLine(env.ledgerPath, `- PUBLISH ${result.started_at} | ${parts.join(" | ").replace(/\n/g, " ")}`);
  fs.writeFileSync(rec, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}

export { GateClosedError };
export function publishInitialized(env: Pick<PublishEnv, "publishDir">): boolean {
  return fs.existsSync(path.join(env.publishDir, ".git"));
}
export { dirSize };

/** One-line summaries for takedown history / ledger. */
export function summarizePush(r: PublishResult): string {
  if (r.status === "pushed") {
    const b = r.post_verify.bare;
    return `pushed ${r.target?.kind} ${r.commit?.slice(0, 12)} (release ${r.release_id}; ${r.verify?.files} files; ${b ? `bare: ${b.commits_in_history} commit, ${b.files_in_repo} files, manifest ${b.ok ? "match" : "MISMATCH"}` : r.post_verify.url_note ?? ""})`;
  }
  return `${r.status} (release ${r.release_id}): ${r.error ?? "?"}`;
}

export function summarize404(r: PublishResult): string {
  if (r.url_404) return `${r.url_404.ok ? "ok" : "FAILED"}: ${r.url_404.url} → ${r.url_404.status}${r.url_404.catalog_mentions.length ? `, catalog still names ${r.url_404.catalog_mentions.join(",")}` : ", catalog clean"} (${r.url_404_note})`;
  return r.url_404_note ?? (r.status === "pushed" ? "not run" : `not run (publish ${r.status})`);
}

/** The takedown / purge push side (WP-5.3). Undefined when publish/ is not initialized (nothing was ever pushed). */
export function makeTakedownHook(env: PublishEnv): import("../works/ops.ts").TakedownPublishHook | undefined {
  if (!publishInitialized(env)) return undefined;
  return async (ctx) => {
    const r = await publishSite(env, { noBuild: true, trigger: ctx.event, reason: ctx.reason ?? undefined, actor: ctx.actor, takedown: { workId: ctx.workId, needles: ctx.needles } });
    const urlOk = r.url_404 ? r.url_404.ok : true;
    return { ok: r.status === "pushed" && urlOk, push: summarizePush(r), url_404_check: summarize404(r), release_id: r.release_id, detail: r };
  };
}
