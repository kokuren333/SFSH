/**
 * AMENDMENT 14: in-stage parallel widths and the global model-call cap — harness/config/parallel.json
 *
 *   {
 *     "global_model_calls": 6,        // model CLI processes running at the same time, shared by every job and
 *                                     // every sfsh process on this PC (model/slots.ts). 1..32
 *     "stage_width_default": 6,       // in-stage width when a stage has no entry. 1..16
 *     "stages": { "claims": 6, ... }  // per-stage override. 1..16
 *   }
 *
 * Stage keys (STAGE_KEYS):
 *   claims        S1 claim extraction batches (claims_r1, follow-up / gapfill extraction)
 *   claim_review  S1 claim review: batches inside one round (rounds stay sequential); the batch size shrinks so that
 *                 the claims of one round fill the width (≥ CLAIM_REVIEW_MIN_BATCH per batch)
 *   search        Luna web_search calls of search_plot / follow-up / gapfill (processing the results stays sequential:
 *                 budget accounting and fetch order are deterministic)
 *   nkg_author    S2 authoring groups of one wave (the wave order is a dependency and stays)
 *   nkg_review    S2 fact / interp review and revision: group calls inside one round (rounds stay sequential)
 *   write         S3 page parts + review / revision groups inside one round
 *   synopsis      S3 synopsis chapters + review / revision groups inside one round
 *
 * The in-stage widths only bound how many calls one stage asks for at once; the global cap decides how many CLI
 * processes really run (a call beyond the cap waits for a slot, its timeout starts when its process starts).
 * Defaults and the reasoning: REQUIREMENTS 4.4「段内の並行（v2.0・A14）」. A missing file means the defaults; an invalid
 * file is an error (no silent fallback to a value the operator did not write).
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";

export const STAGE_KEYS = ["claims", "claim_review", "search", "nkg_author", "nkg_review", "write", "synopsis"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const DEFAULT_GLOBAL_MODEL_CALLS = 6;
export const DEFAULT_STAGE_WIDTH = 6;
export const MAX_GLOBAL_MODEL_CALLS = 32;
export const MAX_STAGE_WIDTH = 16;

export interface ParallelConfig {
  global_model_calls: number;
  stage_width_default: number;
  stages: Partial<Record<StageKey, number>>;
}

export function parallelConfigPath(): string {
  return process.env.SFSH_PARALLEL_CONFIG || path.join(paths.root, "harness", "config", "parallel.json");
}

function int(v: unknown, lo: number, hi: number, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${where} must be an integer ${lo}..${hi} (got ${JSON.stringify(v)})`);
  return v;
}

export function parseParallelConfig(raw: Record<string, unknown>, where = "parallel.json"): ParallelConfig {
  const out: ParallelConfig = {
    global_model_calls: raw.global_model_calls === undefined ? DEFAULT_GLOBAL_MODEL_CALLS : int(raw.global_model_calls, 1, MAX_GLOBAL_MODEL_CALLS, `${where}: global_model_calls`),
    stage_width_default: raw.stage_width_default === undefined ? DEFAULT_STAGE_WIDTH : int(raw.stage_width_default, 1, MAX_STAGE_WIDTH, `${where}: stage_width_default`),
    stages: {},
  };
  const st = raw.stages ?? {};
  if (typeof st !== "object" || Array.isArray(st) || st === null) throw new Error(`${where}: stages must be an object`);
  for (const [k, v] of Object.entries(st as Record<string, unknown>)) {
    if (!(STAGE_KEYS as readonly string[]).includes(k)) throw new Error(`${where}: unknown stage key "${k}" (known: ${STAGE_KEYS.join(", ")})`);
    out.stages[k as StageKey] = int(v, 1, MAX_STAGE_WIDTH, `${where}: stages.${k}`);
  }
  return out;
}

let cached: { file: string; mtimeMs: number; cfg: ParallelConfig } | null = null;

/** Read harness/config/parallel.json (re-read when the file changes; cheap stat per call). */
export function loadParallelConfig(file: string = parallelConfigPath()): ParallelConfig {
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    return { global_model_calls: DEFAULT_GLOBAL_MODEL_CALLS, stage_width_default: DEFAULT_STAGE_WIDTH, stages: {} };
  }
  if (cached && cached.file === file && cached.mtimeMs === st.mtimeMs) return cached.cfg;
  const cfg = parseParallelConfig(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>, file);
  cached = { file, mtimeMs: st.mtimeMs, cfg };
  return cfg;
}

/** In-stage width for `key` (per-stage override → stage_width_default). */
export function stageWidth(key: StageKey, cfg: ParallelConfig = loadParallelConfig()): number {
  return cfg.stages[key] ?? cfg.stage_width_default;
}
