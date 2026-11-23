import fs from "node:fs";
import path from "node:path";
import { INDEX_FIELDS, type IndexEntry, type Work, type WorksIndex } from "./types.ts";
import { renameSyncRetry } from "../util/fsRetry.ts";

export const STAGING_PREFIX = "_staging-";

/** Write JSON atomically: temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSyncRetry(tmp, file);
}

export function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

export function workDirOf(worksDir: string, workId: string): string {
  return path.join(worksDir, workId);
}

export function workExists(worksDir: string, workId: string): boolean {
  return fs.existsSync(path.join(worksDir, workId, "work.json"));
}

/** Read works/<work_id>/work.json (`workDir` = the work's directory). */
export function readWork(workDir: string): Work {
  return JSON.parse(fs.readFileSync(path.join(workDir, "work.json"), "utf8")) as Work;
}

/** Atomically write works/<work_id>/work.json. */
export function writeWork(workDir: string, work: Work): void {
  writeJsonAtomic(path.join(workDir, "work.json"), work);
}

function toIndexEntry(w: Work): IndexEntry {
  const src = w as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of INDEX_FIELDS) out[k] = src[k] ?? (k === "aliases" || k === "creators" || k === "genres" || k === "tags" ? [] : null);
  return out as unknown as IndexEntry;
}

/**
 * Rebuild works/INDEX.json from every works/<id>/work.json (skips _staging-* and dirs without work.json).
 * Writes exactly the §4.6 INDEX fields, sorted by work_id. Never hand-edited.
 */
export function rebuildIndex(worksDir: string): WorksIndex {
  const works: IndexEntry[] = [];
  if (fs.existsSync(worksDir)) {
    for (const d of fs.readdirSync(worksDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(STAGING_PREFIX) || d.name.startsWith(".")) continue;
      const f = path.join(worksDir, d.name, "work.json");
      if (!fs.existsSync(f)) continue;
      works.push(toIndexEntry(JSON.parse(fs.readFileSync(f, "utf8")) as Work));
    }
  }
  works.sort((a, b) => (a.work_id < b.work_id ? -1 : a.work_id > b.work_id ? 1 : 0));
  const index: WorksIndex = { works };
  writeJsonAtomic(path.join(worksDir, "INDEX.json"), index);
  return index;
}

/** Read works/INDEX.json; rebuild it when missing. */
export function readIndex(worksDir: string): WorksIndex {
  const f = path.join(worksDir, "INDEX.json");
  if (!fs.existsSync(f)) return rebuildIndex(worksDir);
  return JSON.parse(fs.readFileSync(f, "utf8")) as WorksIndex;
}
