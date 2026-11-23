import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SearchCallRecord } from "./candidates.ts";
import type { Claim, ClaimReviewEntry } from "./claimTypes.ts";
import type { BudgetState, Candidate, FetchDecision, ResearchGap, SourceCard } from "./types.ts";

/**
 * Small synchronous readers/writers for works/<id>/research/*.json (WP-1.3).
 * Every write goes to a temp file and is renamed into place; append helpers re-read the file
 * first so earlier records are never lost.
 */

export const RESEARCH_FILES = {
  sources: "research/sources.json",
  claims: "research/claims.json",
  claimsReview: "research/claims_review.json",
  searchLog: "research/search_log.json",
  candidates: "research/candidates.json",
  fetchLog: "research/fetch_log.json",
  gaps: "research/gaps.json",
  budget: "research/budget.json",
} as const;

export type ResearchFile = keyof typeof RESEARCH_FILES;

export interface CandidatesFile {
  selected: Candidate[];
  rejected: { url: string; reason: string; why?: string }[];
}

export function researchPath(workDir: string, file: ResearchFile): string {
  return join(workDir, RESEARCH_FILES[file]);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const txt = readFileSync(path, "utf8");
  if (!txt.trim()) return fallback;
  return JSON.parse(txt) as T;
}

let tmpSeq = 0;

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    // Windows: renaming over a file briefly held open elsewhere can fail (EPERM/EBUSY). Fall back to a copy.
    try {
      writeFileSync(path, readFileSync(tmp));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

function readArray<T>(workDir: string, file: ResearchFile): T[] {
  const v = readJsonFile<unknown>(researchPath(workDir, file), []);
  return Array.isArray(v) ? (v as T[]) : [];
}

function appendArray<T>(workDir: string, file: ResearchFile, items: T[]): void {
  if (items.length === 0 && existsSync(researchPath(workDir, file))) return;
  writeJsonAtomic(researchPath(workDir, file), [...readArray<T>(workDir, file), ...items]);
}

// sources.json
export const readSources = (workDir: string): SourceCard[] => readArray<SourceCard>(workDir, "sources");
export const writeSources = (workDir: string, cards: SourceCard[]): void => writeJsonAtomic(researchPath(workDir, "sources"), cards);
export const appendSources = (workDir: string, cards: SourceCard[]): void => appendArray(workDir, "sources", cards);

// claims.json
export const readClaims = (workDir: string): Claim[] => readArray<Claim>(workDir, "claims");
export const writeClaims = (workDir: string, claims: Claim[]): void => writeJsonAtomic(researchPath(workDir, "claims"), claims);

// claims_review.json
export const readClaimsReview = (workDir: string): ClaimReviewEntry[] => readArray<ClaimReviewEntry>(workDir, "claimsReview");
export const appendClaimsReview = (workDir: string, entries: ClaimReviewEntry[]): void => appendArray(workDir, "claimsReview", entries);

// search_log.json
export const readSearchLog = (workDir: string): SearchCallRecord[] => readArray<SearchCallRecord>(workDir, "searchLog");
export const appendSearchLog = (workDir: string, recs: SearchCallRecord[]): void => appendArray(workDir, "searchLog", recs);

// candidates.json
export function readCandidates(workDir: string): CandidatesFile {
  const v = readJsonFile<Partial<CandidatesFile>>(researchPath(workDir, "candidates"), {});
  return { selected: v.selected ?? [], rejected: v.rejected ?? [] };
}
export function appendCandidates(workDir: string, add: CandidatesFile): void {
  const cur = readCandidates(workDir);
  writeJsonAtomic(researchPath(workDir, "candidates"), {
    selected: [...cur.selected, ...add.selected],
    rejected: [...cur.rejected, ...add.rejected],
  });
}

// fetch_log.json
export const readFetchLog = (workDir: string): FetchDecision[] => readArray<FetchDecision>(workDir, "fetchLog");
export const appendFetchLog = (workDir: string, ds: FetchDecision[]): void => appendArray(workDir, "fetchLog", ds);

// gaps.json
export const readGaps = (workDir: string): ResearchGap[] => readArray<ResearchGap>(workDir, "gaps");
export const appendGaps = (workDir: string, gaps: ResearchGap[]): void => appendArray(workDir, "gaps", gaps);

// budget.json
export const readBudget = (workDir: string): BudgetState | null => readJsonFile<BudgetState | null>(researchPath(workDir, "budget"), null);
export const writeBudget = (workDir: string, b: BudgetState): void => writeJsonAtomic(researchPath(workDir, "budget"), b);

/** Saved main text of a source (research/raw/<sid>.txt), or null when missing. */
export function readRawText(workDir: string, card: Pick<SourceCard, "source_id" | "raw_text_path">): string | null {
  const p = join(workDir, card.raw_text_path || `research/raw/${card.source_id}.txt`);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}
