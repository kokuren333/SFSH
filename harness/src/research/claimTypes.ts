/**
 * Claim contract (PLAN §2, WP-1.3). Imported by WP-1.4/1.5 (NKG) and the job runner.
 * A claim is a fact / relation / cause written in our own words. It never stores source text:
 * the backing is kept only as positions (`evidence`) inside research/raw/<sid>.txt (C-2).
 */

export type ClaimAspect =
  | "bibliographic"
  | "title"
  | "genre"
  /** AMENDMENT 12: event-granular synopsis fact (who did what, what happened next), the "plot frame". */
  | "plot"
  | "M01" | "M02" | "M03" | "M04" | "M05" | "M06"
  | "M07" | "M08" | "M09" | "M10" | "M11" | "M12";

export const CLAIM_ASPECTS: readonly ClaimAspect[] = [
  "bibliographic", "title", "genre", "plot",
  "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11", "M12",
];

export type Epistemic = "canon" | "consensus" | "fan_theory";
export type PhaseHint = "early" | "middle" | "end" | "whole" | "unknown";
export type Spoiler = "none" | "mid" | "ending";
export type ClaimReviewState = "pending" | "agreed" | "revised" | "disputed";
export type ClaimDropReason = null | "evidence_not_found" | "copied_phrase" | "review_unsupported" | "no_source_card";

export interface ClaimEvidence {
  source_id: string;
  offset: number;
  length: number;
}

export interface Claim {
  claim_id: string; // c0001
  text: string; // own words, ~160 chars
  source_ids: string[]; // only sources that have a source card
  evidence: ClaimEvidence[]; // verbatim-verified spans in raw/<sid>.txt
  aspects: string[]; // "bibliographic"|"title"|"genre"|"M01".."M12"
  epistemic: Epistemic;
  phase_hint: PhaseHint;
  spoiler: Spoiler;
  entities: string[];
  /**
   * AMENDMENT 12: episode / chapter number the fact belongs to when the source states it (null = unknown).
   * Absent on claims extracted before A12.
   */
  story_unit?: number | null;
  /** AMENDMENT 12: names of the characters involved (people only). Absent on claims extracted before A12. */
  characters?: string[];
  authored_by: "luna";
  reviewed_by: "haiku" | null;
  review: ClaimReviewState;
  status: "active" | "dropped";
  drop_reason: ClaimDropReason;
}

/** research/claims.json is a plain Claim[] (PLAN §1). */
export type ClaimsFile = Claim[];

export type FindingType = "unsupported" | "overreach" | "copied_phrase" | "misclassified" | "missing";

export interface ClaimFinding {
  target_id: string | null;
  type: FindingType;
  severity: "low" | "medium" | "high";
  /** Short note in Haiku's own words (not a quote). */
  evidence: string;
  missing_aspect: string | null;
  suggested_query: string | null;
}

export interface ClaimAction {
  claim_id: string;
  action: "revise" | "drop" | "keep";
  text: string | null;
  epistemic: Epistemic | null;
  reason: string;
}

export interface MissingAspect {
  aspect: string | null;
  suggested_query: string | null;
  note: string;
}

/** One entry of research/claims_review.json (one per round × batch). */
export interface ClaimReviewEntry {
  round: number;
  batch: number;
  at: string;
  claim_ids: string[];
  findings: ClaimFinding[];
  actions: ClaimAction[];
  /** State per claim after applying the actions. */
  outcomes: { claim_id: string; review: ClaimReviewState; status: "active" | "dropped"; drop_reason: ClaimDropReason }[];
  missing: MissingAspect[];
}

export function isClaimAspect(s: string): s is ClaimAspect {
  return (CLAIM_ASPECTS as readonly string[]).includes(s);
}

export function claimIdFor(n: number): string {
  return "c" + String(n).padStart(4, "0");
}

export function nextClaimNumber(claims: Claim[]): number {
  let max = 0;
  for (const c of claims) {
    const m = /^c(\d+)$/.exec(c.claim_id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
