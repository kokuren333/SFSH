import fs from "node:fs";
import path from "node:path";
import { importBatch } from "../queue/batch/import.ts";
import { defaultQueueEnv, ensureQueueDirs, type QueueEnv } from "../queue/store.ts";
import type { Origin, Priority } from "../queue/types.ts";

/**
 * `sfsh import <file> [--range <r>] [--medium <m>] [--priority [high|normal]] [--dry-run] [--origin muse|cli] [--json]` (§4.5)
 * `--priority` without a value means high. Exit: 0 ok / 2 usage (bad option, unreadable file) / 3 file rejected
 * (undecodable, over the limit, malformed CSV …; nothing was enqueued).
 */
export const IMPORT_USAGE = "usage: sfsh import <file> [--range <r>] [--medium <m>] [--priority [high|normal]] [--dry-run] [--origin muse|cli] [--json]";

interface Parsed {
  file: string;
  range: string | null;
  medium: string | null;
  priority: Priority | null;
  dryRun: boolean;
  origin: Origin;
  json: boolean;
}

function parseArgs(args: string[]): Parsed | string {
  const p: Partial<Parsed> = { range: null, medium: null, priority: null, dryRun: false, origin: "cli", json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    if (a === "--json") p.json = true;
    else if (a === "--dry-run") p.dryRun = true;
    else if (a === "--range" || a === "--medium") {
      const v = value();
      if (v === undefined) return `${a} needs a value\n${IMPORT_USAGE}`;
      if (a === "--range") p.range = v;
      else p.medium = v;
    } else if (a === "--priority") {
      const next = args[i + 1];
      if (next === "high" || next === "normal") {
        p.priority = next;
        i++;
      } else if (next === undefined || next.startsWith("--")) p.priority = "high";
      else return `--priority is high or normal: ${next}\n${IMPORT_USAGE}`;
    } else if (a === "--origin") {
      const v = value();
      if (v !== "muse" && v !== "cli") return `--origin is muse or cli\n${IMPORT_USAGE}`;
      p.origin = v;
    } else if (a.startsWith("-")) return `unknown option: ${a}\n${IMPORT_USAGE}`;
    else if (p.file === undefined) p.file = a;
    else return `unexpected argument: ${a}\n${IMPORT_USAGE}`;
  }
  if (!p.file) return IMPORT_USAGE;
  return p as Parsed;
}

export async function importCommand(args: string[], env: QueueEnv = defaultQueueEnv(), now: () => Date = () => new Date()): Promise<number> {
  const p = parseArgs(args);
  if (typeof p === "string") {
    console.error(p);
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(path.resolve(p.file));
  } catch (e) {
    console.error(`sfsh import: cannot read ${p.file}: ${(e as Error).message}`);
    return 2;
  }
  if (!p.dryRun) ensureQueueDirs(env);
  const r = importBatch(env, { fileName: path.basename(p.file), bytes, range: p.range, medium: p.medium, priority: p.priority, origin: p.origin, dryRun: p.dryRun }, now());
  if (p.json) console.log(JSON.stringify(r.ok ? { ok: true, dry_run: r.dryRun, batch_id: r.dryRun ? null : r.batch.batch_id, plan: r.plan } : r, null, 2));
  else if (r.ok) console.log(r.text + (r.dryRun ? "" : `\n照会: sfsh status --batch ${r.batch.batch_id}`));
  else console.error(`sfsh import: ${r.text}`);
  if (r.ok) return 0;
  return r.kind === "usage" ? 2 : 3;
}
