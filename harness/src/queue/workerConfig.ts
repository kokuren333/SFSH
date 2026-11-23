/**
 * Worker settings (AMENDMENT 13): harness/config/worker.json
 *
 *   { "max_concurrent_jobs": 3 }
 *
 * max_concurrent_jobs = job slots the worker runs at the same time (1..MAX_CONCURRENT_JOBS). Default 3 (REQUIREMENTS
 * 4.4 "並行実行"): a job mostly waits on model CLI child processes and fetches (CPU idle meanwhile); a model CLI process
 * measured ~80 MB on average (max ~0.7 GB) and one job keeps 3–6 calls in flight, so 3 jobs ≈ 9–18 calls ≈ 1–2 GB on
 * this 15.8 GB / 8-thread PC, leaving room for the browser and other work, and keeps the CLI rate limits in reach. `sfsh worker
 * --concurrency n` overrides the file for one run. A missing file means the default; an invalid file is an error
 * (the worker does not start with a value it cannot read).
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";

export const DEFAULT_CONCURRENT_JOBS = 3;
export const MAX_CONCURRENT_JOBS = 8;

export interface WorkerConfig {
  max_concurrent_jobs: number;
}

export function workerConfigPath(): string {
  return path.join(paths.root, "harness", "config", "worker.json");
}

export function parseConcurrency(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_CONCURRENT_JOBS) throw new Error(`${where}: max_concurrent_jobs must be an integer 1..${MAX_CONCURRENT_JOBS} (got ${JSON.stringify(v)})`);
  return v;
}

export function loadWorkerConfig(file: string = workerConfigPath()): WorkerConfig {
  if (!fs.existsSync(file)) return { max_concurrent_jobs: DEFAULT_CONCURRENT_JOBS };
  const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  return { max_concurrent_jobs: raw.max_concurrent_jobs === undefined ? DEFAULT_CONCURRENT_JOBS : parseConcurrency(raw.max_concurrent_jobs, file) };
}
