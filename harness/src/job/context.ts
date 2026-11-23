import type { ModelPort } from "../model/types.ts";
import type { BudgetState, Fetcher } from "../research/types.ts";

/**
 * Context handed to every S0–S2 stage function (CP-016). The job runner (harness/src/job/) builds it;
 * stage modules (research/*, nkg/*) only consume it. Tests build it with fake ports / fetchers.
 */
export interface StageContext {
  jobId: string;
  /** Absolute path of works/<work_id>/ . */
  workDir: string;
  workId: string;
  /** Range of the job (4.1). */
  range: { unit: "whole" | "volume" | "episode" | "arc" | "season"; from: number | null; to: number | null; label: string }[];
  luna: ModelPort;
  haiku: ModelPort;
  fetcher: Fetcher;
  /** Shared mutable budget for the whole job (identification + research). Persisted by the stage that changes it. */
  budget: BudgetState;
  now: () => Date;
  /** Append one line to logs/jobs/<job_id>.log (human-readable progress). */
  log: (msg: string) => void;
}

/** Result every stage returns to the runner. Stages never throw for "information shortage" (P-1). */
export interface StageResult {
  /** Files written (relative to workDir). */
  outputs: string[];
  /** Short numbers for the ledger, e.g. { claims: 42, dropped: 3 }. */
  metrics: Record<string, number | string>;
  /** Non-blocking notes (advisory / gaps). */
  warnings: string[];
}
