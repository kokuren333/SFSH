import type { ModelPort } from "../model/types.ts";
import type { BudgetState, Fetcher } from "../research/types.ts";
import type { FramePlan } from "../research/frames.ts";

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
  /**
   * S3 write parts to run (AMENDMENT 11): "pages" = overview / figure notes / essays / quiz, "synopsis" = the long
   * spoiler synopsis. Absent = both (full jobs). `sfsh regen --parts synopsis` writes the synopsis only.
   */
  writeParts?: readonly WritePartName[];
  /** AMENDMENT 12 research frame plan (caps / reserves inside the job budget). Absent = FRAMES. */
  frames?: FramePlan;
  /** AMENDMENT 12: review rounds of the S2 fact / interp layers for this run (1..2, §3.3). Absent = REVIEW_MAX_ROUNDS. */
  reviewRounds?: number;
  /**
   * AMENDMENT 15: shape-only hints for a conformance repair run (check/conformance.ts). Only counts / presence
   * ("at least N events", "the reverse plot needs an outcome") — never an angle, a reading or a wording (P-1).
   */
  repair?: RepairHints;
}

/** AMENDMENT 15: hints handed to the stages re-run by the conformance repair loop (absent in normal runs). */
export interface RepairHints {
  /** attempt number of the repair (1..) */
  attempt: number;
  /** refact: rebuild the fact layer even when gapfill added no claims, with these minimum counts */
  fact?: { minEvents: number; minEventsPerPhase: number; minEventsLastPhase: number; notes: string[] };
  /** interp: minimum counts / presence for the interpretive layer */
  interp?: { notes: string[] };
  /** synopsis: re-plan from the chapter plan with the measured shortfall */
  synopsis?: { previousChars: number; target: readonly [number, number]; unassignedEventIds: string[]; notes: string[] };
}

export const WRITE_PART_NAMES = ["pages", "synopsis"] as const;
export type WritePartName = (typeof WRITE_PART_NAMES)[number];

/** Result every stage returns to the runner. Stages never throw for "information shortage" (P-1). */
export interface StageResult {
  /** Files written (relative to workDir). */
  outputs: string[];
  /** Short numbers for the ledger, e.g. { claims: 42, dropped: 3 }. */
  metrics: Record<string, number | string>;
  /** Non-blocking notes (advisory / gaps). */
  warnings: string[];
}
