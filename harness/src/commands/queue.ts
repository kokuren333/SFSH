/**
 * M4 queue CLI (WP-4.1, §4.3): enqueue / status / cancel / answer / worker. The local CLI user is the owner (§4.3).
 *
 *   sfsh enqueue --work "<t>" [--range r] [--medium m] [--note t] [--priority high|normal] [--origin muse|cli] [--url u]... [--json]
 *   sfsh status [<job_id> | --batch <batch_id>] [--json]
 *   sfsh cancel <job_id> | --batch <batch_id>
 *   sfsh answer <job_id> [--pick n] [--work t] [--medium m] [--range r]
 *   sfsh worker [--once] [--poll-ms n] [--max-jobs n]
 */
import { getModelPort } from "../model/index.ts";
import { createFetcher } from "../research/fetch/index.ts";
import { WorkerBusyError } from "../queue/lock.ts";
import { answerJob, cancelJob, type AnswerInput } from "../queue/ops.ts";
import { localRequester, submitJob } from "../queue/request.ts";
import { jobStatus, queueSummary } from "../queue/status.ts";
import { defaultQueueEnv, ensureQueueDirs, type QueueEnv } from "../queue/store.ts";
import type { Actor, JobInput, Origin, Priority } from "../queue/types.ts";
import { runWorker, type WorkerDeps } from "../queue/worker.ts";
import { loadPublishConfig, type PublishConfig } from "../publish/config.ts";
import { defaultPublishEnv, publishInitialized, publishSite, summarizePush } from "../publish/index.ts";
import { batchStatus, cancelBatch } from "../queue/batch/status.ts";
import { batchHook } from "../queue/service.ts";

const USAGE = {
  enqueue: 'usage: sfsh enqueue --work "<title>" [--range r] [--medium m] [--note t] [--priority high|normal] [--origin muse|cli] [--url u]... [--json]',
  status: "usage: sfsh status [<job_id>] [--json]  |  sfsh status --batch <batch_id>",
  cancel: "usage: sfsh cancel <job_id>  |  sfsh cancel --batch <batch_id>",
  answer: "usage: sfsh answer <job_id> [--pick n] [--work t] [--medium m] [--range r]",
  worker: "usage: sfsh worker [--once] [--poll-ms n] [--max-jobs n]",
};

/** Local CLI actor = owner (§4.3). */
export function cliActor(origin: Origin = "cli"): Actor {
  const r = localRequester();
  return { id: r.id, name: r.name, origin, is_owner: true };
}

export async function enqueueCommand(args: string[], env: QueueEnv = defaultQueueEnv()): Promise<number> {
  const input: JobInput = { origin: "cli", work: "", instruction_urls: [] };
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--json") json = true;
    else if (a === "--work" && v !== undefined) (input.work = v), i++;
    else if (a === "--range" && v !== undefined) (input.range = v), i++;
    else if (a === "--medium" && v !== undefined) (input.medium = v), i++;
    else if (a === "--note" && v !== undefined) (input.note = v), i++;
    else if (a === "--priority" && (v === "high" || v === "normal")) (input.priority = v as Priority), i++;
    else if (a === "--origin" && (v === "muse" || v === "cli")) (input.origin = v as Origin), i++;
    else if (a === "--url" && v !== undefined) input.instruction_urls!.push({ url: v, note: "instruction (--url)" }), i++;
    else {
      console.error(`unknown or incomplete option: ${a}\n${USAGE.enqueue}`);
      return 2;
    }
  }
  if (!input.work.trim()) {
    console.error(`--work is required\n${USAGE.enqueue}`);
    return 2;
  }
  ensureQueueDirs(env);
  const r = submitJob(env, input);
  if (!r.ok) {
    if (json) console.log(JSON.stringify({ ok: false, errors: r.errors }, null, 2));
    else console.error(`rejected: ${r.errors.join(" / ")}`);
    return 3;
  }
  const j = r.job!;
  if (json) console.log(JSON.stringify(j, null, 2));
  else console.log(`queued to inbox: ${j.job_id}「${j.work_query}」 range ${j.range_raw || "全体"}${j.range === null ? " (unparsed → the worker will ask back)" : ""}  — run \`sfsh worker\` to process; \`sfsh status ${j.job_id}\` to check`);
  return 0;
}

export async function statusCommand(args: string[], env: QueueEnv = defaultQueueEnv()): Promise<number> {
  const json = args.includes("--json");
  const bi = args.indexOf("--batch");
  if (bi >= 0) {
    const id = args[bi + 1];
    if (!id || id.startsWith("-")) {
      console.error(USAGE.status);
      return 2;
    }
    const v = batchStatus(env, id);
    console.log(json ? JSON.stringify(v.data, null, 2) : v.text);
    return v.ok ? 0 : 3;
  }
  const rest = args.filter((a) => a !== "--json");
  if (rest.some((a) => a.startsWith("-"))) {
    console.error(USAGE.status);
    return 2;
  }
  const id = rest[0];
  const v = id ? jobStatus(env, id) : queueSummary(env);
  console.log(json ? JSON.stringify(v.data, null, 2) : v.text);
  return v.ok ? 0 : 3;
}

export async function cancelCommand(args: string[], env: QueueEnv = defaultQueueEnv()): Promise<number> {
  const hook = { afterTransition: batchHook(env) };
  const bi = args.indexOf("--batch");
  if (bi >= 0) {
    const bid = args[bi + 1];
    if (!bid || bid.startsWith("-")) {
      console.error(USAGE.cancel);
      return 2;
    }
    const actor = cliActor();
    const r = cancelBatch(env, bid, actor, (jobId) => cancelJob(env, jobId, actor, new Date(), hook));
    (r.ok ? console.log : console.error)(r.text);
    return r.ok ? 0 : 3;
  }
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    console.error(USAGE.cancel);
    return 2;
  }
  const r = cancelJob(env, id, cliActor(), new Date(), hook);
  (r.ok ? console.log : console.error)(r.text);
  return r.ok ? 0 : 3;
}

export async function answerCommand(args: string[], env: QueueEnv = defaultQueueEnv()): Promise<number> {
  let id: string | null = null;
  const ans: AnswerInput = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--pick" && v !== undefined) {
      const n = Number(v);
      if (!Number.isInteger(n)) {
        console.error(`--pick needs a number\n${USAGE.answer}`);
        return 2;
      }
      ans.pick = n;
      i++;
    } else if (a === "--work" && v !== undefined) (ans.work = v), i++;
    else if (a === "--medium" && v !== undefined) (ans.medium = v), i++;
    else if (a === "--range" && v !== undefined) (ans.range = v), i++;
    else if (!a.startsWith("-") && id === null) id = a;
    else {
      console.error(`unknown or incomplete option: ${a}\n${USAGE.answer}`);
      return 2;
    }
  }
  if (!id) {
    console.error(USAGE.answer);
    return 2;
  }
  const r = answerJob(env, id, ans, cliActor(), new Date(), { afterTransition: batchHook(env) });
  (r.ok ? console.log : console.error)(r.text);
  return r.ok ? 0 : 3;
}

/**
 * S6 auto publish (§5.3, U-07): only when the production gate is open (opening instructed, U-05), mode is "auto"
 * and publish/ is initialized. Otherwise undefined → jobs stop at built.
 */
export function autoPublishHook(env: QueueEnv, cfgIn?: PublishConfig): WorkerDeps["publish"] {
  let cfg: PublishConfig;
  try {
    cfg = cfgIn ?? loadPublishConfig();
  } catch (e) {
    console.error(`worker: publish config unusable, auto publish off: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (!cfg.production_enabled || cfg.mode !== "auto") return undefined;
  if (process.env.NODE_TEST_CONTEXT && !cfgIn) return undefined;
  const penv = { ...defaultPublishEnv(cfg), worksDir: env.worksDir, distDir: env.siteOut, ledgerPath: env.ledgerPath };
  if (!publishInitialized(penv)) return undefined;
  return async ({ jobId }) => {
    const r = await publishSite(penv, { trigger: "worker", actor: `worker(job ${jobId})` });
    return { ok: r.status === "pushed", summary: summarizePush(r), release_id: r.release_id };
  };
}

export async function workerCommand(args: string[], env: QueueEnv = defaultQueueEnv()): Promise<number> {
  const opts: { once?: boolean; pollMs?: number; maxJobs?: number; signal?: AbortSignal } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--once") opts.once = true;
    else if (a === "--poll-ms" && v !== undefined && Number(v) > 0) (opts.pollMs = Number(v)), i++;
    else if (a === "--max-jobs" && v !== undefined && Number.isInteger(Number(v)) && Number(v) > 0) (opts.maxJobs = Number(v)), i++;
    else {
      console.error(`unknown or incomplete option: ${a}\n${USAGE.worker}`);
      return 2;
    }
  }
  const ac = new AbortController();
  opts.signal = ac.signal;
  const onSig = () => {
    console.error("worker: stopping at the next stage boundary (Ctrl+C again to kill)");
    ac.abort();
    process.off("SIGINT", onSig);
  };
  process.on("SIGINT", onSig);
  try {
    const s = await runWorker(env, { luna: getModelPort("luna"), haiku: getModelPort("haiku"), fetcher: createFetcher(), publish: autoPublishHook(env) }, opts);
    if (s.tookOverFrom !== null) console.log(`worker: took over a stale lock (pid ${s.tookOverFrom})`);
    for (const r of s.recovered) console.log(`worker: recovered ${r}`);
    console.log(`worker: identified ${s.identified.length}; processed ${s.processed.map((p) => `${p.job_id}:${p.state}`).join(", ") || "none"}`);
    return 0;
  } catch (e) {
    if (e instanceof WorkerBusyError) {
      console.error(e.message);
      return 3;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSig);
  }
}
