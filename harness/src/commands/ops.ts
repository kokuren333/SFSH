import path from "node:path";
import { paths } from "../paths.ts";
import {
  holdWork,
  purgeWork,
  releaseWork,
  takedownWork,
  TakedownVerificationError,
  UnknownWorkError,
  type BuildLike,
  type OpsResult,
  type PurgeResult,
  type TakedownResult,
} from "../works/ops.ts";
import { requeueHeldJobs } from "../queue/held.ts";
import { batchHook } from "../queue/service.ts";
import { defaultQueueEnv, type QueueEnv } from "../queue/store.ts";
import { loadPublishConfig, resolveTarget } from "../publish/config.ts";
import { defaultPublishEnv, makeTakedownHook, type PublishEnv } from "../publish/index.ts";

/**
 * `sfsh hold <work_id> [--reason <t>] [--json]`
 * `sfsh release <work_id> [--reason <t>] [--json]`
 * `sfsh takedown <work_id> [--reason <t>] [--out <dir>] [--base-url <url>] [--json]`   local part + push side (M5)
 * `sfsh purge <work_id> [--reason <t>] [--out <dir>] [--base-url <url>] [--json]`      local part + push side (M5)
 * The push side runs when the env carries a publish env whose publish/ is initialized (default CLI env: the
 * configured target — while the production gate is closed, the local test bare). Test envs without `publish` never push.
 * Exit: 0 ok / 2 usage or unknown work_id / 3 operation failed (e.g. takedown verification found a trace).
 */
export interface OpsCommandEnv {
  worksDir: string;
  jobsDir: string;
  ledgerPath: string;
  /** Default site output for takedown/purge. */
  defaultOut: string;
  build?: BuildLike;
  actor?: string;
  /** M4: queue (release puts the work's held queue jobs back to queued). Default: the repo queue/. */
  queue?: QueueEnv;
  /** M5: publish env for the takedown / purge push side. Absent → push recorded as not run. */
  publish?: PublishEnv;
}

export function defaultOpsEnv(): OpsCommandEnv {
  let publish: PublishEnv | undefined;
  try {
    // Never attach the real publish env inside the test runner (tests pass their own env).
    if (!process.env.NODE_TEST_CONTEXT) publish = defaultPublishEnv(loadPublishConfig());
  } catch (e) {
    console.error(`publish config unusable, takedown will not push: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    worksDir: paths.works,
    jobsDir: paths.jobLogDir,
    ledgerPath: path.join(paths.root, "logs", "LEDGER.md"),
    defaultOut: path.join(paths.root, "site", "dist"),
    publish,
  };
}

interface Parsed {
  workId: string;
  reason?: string;
  out?: string;
  baseUrl?: string;
  json: boolean;
}

function parse(cmd: string, args: string[], withBuild: boolean): Parsed | string {
  const usage = withBuild ? `usage: sfsh ${cmd} <work_id> [--reason <t>] [--out <dir>] [--base-url <url>] [--json]` : `usage: sfsh ${cmd} <work_id> [--reason <t>] [--json]`;
  const p: Partial<Parsed> & { json: boolean } = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    if (a === "--json") p.json = true;
    else if (a === "--reason") {
      const v = value();
      if (v === undefined) return `--reason needs a value\n${usage}`;
      p.reason = v;
    } else if (withBuild && a === "--out") {
      const v = value();
      if (v === undefined) return `--out needs a value\n${usage}`;
      p.out = v;
    } else if (withBuild && a === "--base-url") {
      const v = value();
      if (v === undefined) return `--base-url needs a value\n${usage}`;
      p.baseUrl = v;
    } else if (a.startsWith("-")) return `unknown option: ${a}\n${usage}`;
    else if (p.workId === undefined) p.workId = a;
    else return `unexpected argument: ${a}\n${usage}`;
  }
  if (!p.workId) return usage;
  return p as Parsed;
}

function printResult(r: OpsResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`${r.event} ${r.work_id}: ${r.previous_publish_mode} -> ${r.publish_mode}${r.no_change ? " (no change; re-recorded)" : ""} in ${r.elapsed_ms.toFixed(1)} ms`);
  for (const j of r.jobs) {
    const what =
      j.action === "held" ? `set to held (was ${j.previous_state})` : j.action === "running" ? `running (pid ${j.pid}); the runner holds it at the next stage boundary` : `held; continue with: sfsh job resume ${j.job_id}`;
    console.log(`  job ${j.job_id}: ${what}`);
  }
  if (!r.jobs.length) console.log("  no unfinished jobs for this work");
  const td = r as Partial<TakedownResult>;
  if (td.verification) {
    console.log(`  rebuilt ${td.build?.out} in ${Math.round(td.build?.elapsed_ms ?? 0)} ms; verified ${td.verification.files_scanned} files for ${td.verification.needles.length} identifying strings: ${td.verification.traces.length} traces`);
    if (td.verification.skipped_needles.length) console.log(`  skipped (too short to search): ${td.verification.skipped_needles.join(", ")}`);
    console.log(`  push: ${td.push}`);
    console.log(`  URL 404 check: ${td.url_404_check}`);
  }
  const pg = r as Partial<PurgeResult>;
  if (pg.deleted) console.log(`  deleted: ${pg.deleted.length ? pg.deleted.join(", ") : "(gen/ and releases/ were absent)"}; kept: ${pg.kept?.join(", ")}`);
  console.log(`  ledger: ${r.ledger_line}`);
}

async function runOp(cmd: "hold" | "release" | "takedown" | "purge", args: string[], env: OpsCommandEnv): Promise<number> {
  const withBuild = cmd === "takedown" || cmd === "purge";
  const p = parse(cmd, args, withBuild);
  if (typeof p === "string") {
    console.error(p);
    return 2;
  }
  const base = { worksDir: env.worksDir, workId: p.workId, reason: p.reason, actor: env.actor, jobsDir: env.jobsDir, ledgerPath: env.ledgerPath };
  try {
    let r: OpsResult;
    if (cmd === "hold") r = holdWork(base);
    else if (cmd === "release") {
      r = releaseWork(base);
      const q = env.queue ?? { ...defaultQueueEnv(), worksDir: env.worksDir, jobsDir: env.jobsDir, ledgerPath: env.ledgerPath };
      const requeued = requeueHeldJobs(q, p.workId, new Date(), batchHook(q));
      if (requeued.length && !p.json) console.log(`  queue: requeued held jobs ${requeued.join(", ")} (the worker continues them)`);
    }
    else {
      const buildOut = path.resolve(p.out ?? env.defaultOut);
      const pub = env.publish ? { ...env.publish, distDir: buildOut } : undefined;
      let baseUrl = p.baseUrl;
      if (!baseUrl && pub) {
        try {
          baseUrl = resolveTarget(pub.config, pub.repoRoot).baseUrl ?? undefined;
        } catch {
          /* gate misconfigured: the publish run reports it */
        }
      }
      const o = { ...base, buildOut, baseUrl, build: env.build, publish: pub ? makeTakedownHook(pub) : undefined };
      r = cmd === "takedown" ? await takedownWork(o) : await purgeWork(o);
    }
    printResult(r, p.json);
    return 0;
  } catch (e) {
    if (e instanceof UnknownWorkError) {
      console.error(`sfsh ${cmd}: ${e.message} (no works/<work_id>/work.json)`);
      return 2;
    }
    if (e instanceof TakedownVerificationError) {
      printResult(e.result, p.json);
      console.error(`sfsh ${cmd}: ${e.message}`);
      return 3;
    }
    console.error(`sfsh ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
}

export const holdCommand = (args: string[], env: OpsCommandEnv = defaultOpsEnv()) => runOp("hold", args, env);
export const releaseCommand = (args: string[], env: OpsCommandEnv = defaultOpsEnv()) => runOp("release", args, env);
export const takedownCommand = (args: string[], env: OpsCommandEnv = defaultOpsEnv()) => runOp("takedown", args, env);
export const purgeCommand = (args: string[], env: OpsCommandEnv = defaultOpsEnv()) => runOp("purge", args, env);
