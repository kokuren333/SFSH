import path from "node:path";
import { REGEN_STAGES, RegenRefused, runRegen, type RegenDeps, type RegenRecord, type RegenStageRecord } from "../job/regen.ts";
import { getModelPort } from "../model/index.ts";
import { paths } from "../paths.ts";

export const REGEN_USAGE = `regen <work_id> [--stages ${REGEN_STAGES.join(",")}] [--parts pages,synopsis] [--json]`;

/**
 * `sfsh regen <work_id> [--stages write,compose,autocheck] [--parts pages,synopsis] [--json]` (AMENDMENT 09; --parts AMENDMENT 11:
 * the write stage writes the page text and/or the long synopsis — absent = both).
 * Re-runs S3 write → compose → S4 autocheck for an existing work from saved research only (no search / fetch).
 * Exit: 0 ok / 2 usage or refused (nothing changed) / 3 a stage failed (backup kept under gen/_backup-<stamp>/).
 * `deps` is injected by tests; without it the real model ports, works/ and logs/regen/ are used.
 */
export async function regenCommand(args: string[], deps?: RegenDeps): Promise<number> {
  let workId: string | null = null;
  let stages: string[] | undefined;
  let parts: string[] | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--stages" && args[i + 1] !== undefined) stages = args[++i]!.split(",");
    else if (a.startsWith("--stages=")) stages = a.slice("--stages=".length).split(",");
    else if (a === "--parts" && args[i + 1] !== undefined) parts = args[++i]!.split(",");
    else if (a.startsWith("--parts=")) parts = a.slice("--parts=".length).split(",");
    else if (!a.startsWith("-") && workId === null) workId = a;
    else {
      console.error(`unknown option: ${a}\nusage: sfsh ${REGEN_USAGE}`);
      return 2;
    }
  }
  if (!workId) {
    console.error(`usage: sfsh ${REGEN_USAGE}`);
    return 2;
  }
  if (!deps && process.env.NODE_TEST_CONTEXT) {
    console.error("sfsh regen: refusing to run real model calls against the real works under the test runner (pass RegenDeps)");
    return 2;
  }
  const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);
  const tag = `[regen ${workId}]`;
  const d: RegenDeps = {
    ...(deps ?? {
      luna: getModelPort("luna"),
      haiku: getModelPort("haiku"),
      worksDir: paths.works,
      logDir: path.join(paths.root, "logs", "regen"),
      jobsDir: paths.jobLogDir,
    }),
    onStage: (ev) => {
      if (ev.phase === "start") say(`${tag} ${ev.stage}: start (attempt ${ev.attempt})`);
      else printStage(say, tag, ev.record!);
    },
  };
  let rec: RegenRecord;
  try {
    rec = await runRegen(workId, { stages, parts }, d);
  } catch (e) {
    if (e instanceof RegenRefused) {
      console.error(`sfsh regen: ${e.message}`);
      return 2;
    }
    console.error(`sfsh regen: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 3;
  }
  if (json) console.log(JSON.stringify(rec, null, 2));
  else {
    const mc = rec.model_calls;
    say(`${tag} ${rec.ok ? "done" : "FAILED"} in ${(rec.duration_ms / 1000).toFixed(1)}s — model calls ${mc.total} (haiku ok ${mc.by_port.haiku.ok}/failed ${mc.by_port.haiku.failed}, luna ok ${mc.by_port.luna.ok}/failed ${mc.by_port.luna.failed}); network: fetcher ${rec.network.fetcher_calls}, searches ${rec.network.searches_used}, fetches ${rec.network.fetches_used}`);
    say(`${tag} backup: works/${rec.work_id}/${rec.backup_dir}/ (${rec.backup_items.join(", ") || "nothing"})`);
    say(`${tag} record: ${rec.record_file}`);
    if (rec.error) say(`${tag} error: ${rec.error}`);
  }
  return rec.ok ? 0 : 3;
}

function printStage(say: (m: string) => void, tag: string, r: RegenStageRecord): void {
  const secs = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "-";
  if (r.status !== "done") {
    say(`${tag} ${r.stage}: failed (attempt ${r.attempts}, ${secs}): ${r.error}`);
    return;
  }
  say(`${tag} ${r.stage}: done in ${secs} (attempt ${r.attempts})`);
  const m = Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(" ");
  if (m) say(`${tag}   metrics: ${m}`);
  for (const w of r.warnings) say(`${tag}   warning: ${w}`);
}
