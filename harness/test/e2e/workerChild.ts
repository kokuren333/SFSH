/**
 * Queue worker test helpers + child-process entry for the SIGKILL resume test (WP-4.2, gate 7.2 M4).
 *
 *   node harness/test/e2e/workerChild.ts <tmpdir>
 *
 * runs `runWorker(..., { once: true })` on <tmpdir>/{queue,jobs,works,dist} with fake ports (no model calls), every
 * stage except identify overridden by a marker-writing stub (<tmpdir>/markers/<stage>.txt gets one line per run),
 * and an injected build. The stage named by SLOW_STAGE blocks for 60 s on its FIRST run only (so the test can kill
 * the process inside it); later runs return at once.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STAGES, type StageName } from "../../src/job/runner.ts";
import type { StageContext, StageResult } from "../../src/job/context.ts";
import type { ModelPort } from "../../src/model/types.ts";
import { ensureQueueDirs, type QueueEnv } from "../../src/queue/store.ts";
import { runWorker, type WorkerDeps } from "../../src/queue/worker.ts";
import type { Fetcher } from "../../src/research/types.ts";
import { rebuildIndex, writeWork } from "../../src/works/store.ts";
import type { Work } from "../../src/works/types.ts";

export const SLOW_STAGE: StageName = "fact";

export function makeEnv(root: string): QueueEnv {
  const env: QueueEnv = {
    queueDir: path.join(root, "queue"),
    jobsDir: path.join(root, "jobs"),
    worksDir: path.join(root, "works"),
    ledgerPath: path.join(root, "LEDGER.md"),
    siteOut: path.join(root, "dist"),
  };
  ensureQueueDirs(env);
  fs.mkdirSync(env.worksDir, { recursive: true });
  return env;
}

export const noPort = (port: "luna" | "haiku"): ModelPort & { calls: number } => {
  const p = {
    port,
    modelId: "none",
    calls: 0,
    call: async () => {
      p.calls++;
      throw new Error(`no ${port} calls expected`);
    },
  };
  return p;
};
export const noFetcher: Fetcher = { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) };

export const okStage = async (): Promise<StageResult> => ({ outputs: [], metrics: {}, warnings: [] });

/** Every stage but identify → no-op (identify cannot be overridden; tests resolve via the INDEX path). */
export function okOverrides(): Partial<Record<StageName, (ctx: StageContext) => Promise<StageResult>>> {
  const o: Partial<Record<StageName, (ctx: StageContext) => Promise<StageResult>>> = {};
  for (const s of STAGES) if (s !== "identify") o[s] = okStage;
  return o;
}

export function seedWork(env: QueueEnv, w: Partial<Work> & { work_id: string; title: string; medium: string }): void {
  const at = "2026-01-01T00:00:00+09:00";
  const work: Work = {
    title_original: null,
    title_reading: null,
    title_reading_basis: "source",
    title_status: "confirmed",
    title_source_ids: [],
    aliases: [],
    creators: [],
    genres: [],
    tags: [],
    first_release_year: 2001,
    publish_mode: "Public",
    history: [{ at, event: "created", job_id: null }],
    first_published_at: null,
    updated_at: null,
    created_at: at,
    ...w,
  };
  writeWork(path.join(env.worksDir, w.work_id), work);
  rebuildIndex(env.worksDir);
}

export function markerCounts(root: string): Record<string, number> {
  const dir = path.join(root, "markers");
  const out: Record<string, number> = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".txt")) out[f.slice(0, -4)] = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).length;
  return out;
}

/** Marker-writing overrides; SLOW_STAGE blocks on its first run. */
export function markerOverrides(root: string): Partial<Record<StageName, (ctx: StageContext) => Promise<StageResult>>> {
  const dir = path.join(root, "markers");
  fs.mkdirSync(dir, { recursive: true });
  const o: Partial<Record<StageName, (ctx: StageContext) => Promise<StageResult>>> = {};
  for (const s of STAGES) {
    if (s === "identify") continue;
    o[s] = async () => {
      const f = path.join(dir, `${s}.txt`);
      const first = !fs.existsSync(f);
      fs.appendFileSync(f, `pid=${process.pid}\n`, "utf8");
      if (s === SLOW_STAGE && first) await new Promise((r) => setTimeout(r, 60_000));
      return okStage();
    };
  }
  return o;
}

export function childDeps(root: string): WorkerDeps {
  return {
    luna: noPort("luna"),
    haiku: noPort("haiku"),
    fetcher: noFetcher,
    stageOverrides: markerOverrides(root),
    build: async (o) => {
      fs.mkdirSync(o.out, { recursive: true });
      fs.writeFileSync(path.join(o.out, "index.html"), "<!doctype html>built\n");
      return { works: 1 };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node harness/test/e2e/workerChild.ts <tmpdir>");
    process.exit(2);
  }
  const env = makeEnv(root);
  runWorker(env, childDeps(root), { once: true }).then(
    (s) => {
      console.log(JSON.stringify(s));
      process.exitCode = 0;
    },
    (e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 1;
    },
  );
}
