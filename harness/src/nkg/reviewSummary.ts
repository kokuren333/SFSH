/**
 * Review quality metrics (REQUIREMENTS §3.3-4, WP-2.1): finding counts, rounds and deletions per review-bearing
 * stage, written to nkg/review_summary.json and merged (compact) into work.json as `review_stats`.
 *
 * Inputs (all optional; missing / unreadable files are skipped and listed in `skipped`):
 *  - research/claims_review.json  — S1 claim review entries (one per round × batch; S1 + follow-up)
 *  - nkg/reviews/*.json           — S2 layer review files (LayerReviewFile, build.ts)
 *  - gen/reviews/*.json           — S3 review files; read with the same generic reader (an object with
 *                                   `rounds[]{findings, responses}`, or an array of such objects)
 * Older (M1) files without the WP-2.1 fields are summarized from what they have.
 *
 * Called at the end of reviewClaims (S1) and buildLayer (S2). S3 / the runner can call it again at any time:
 * it always recomputes from the files (idempotent).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readWork, writeWork } from "../works/store.ts";
import type { Work } from "../works/types.ts";
import { NO_RESPONSE_REASON } from "./review.ts";
import { writeJson } from "./io.ts";

export const REVIEW_SUMMARY_FILE = "nkg/review_summary.json";
export const CLAIMS_REVIEW_FILE = "research/claims_review.json";
const REVIEW_DIRS: { dir: string; prefix: string }[] = [
  { dir: "nkg/reviews", prefix: "s2" },
  { dir: "gen/reviews", prefix: "s3" },
];

export interface ReviewCounts {
  rounds: number;
  findings: number;
  findings_by_type: Record<string, number>;
  revised: number;
  declined: number;
  unanswered: number;
  disputed: number;
  /** Elements deleted for unresolved copied_phrase (C-2). For claims: dropped with drop_reason copied_phrase. */
  deleted: number;
  advisory: number;
}
export interface StageReviewStats extends ReviewCounts {
  stage: string;
  file: string;
  max_rounds: number | null;
  zeroed_types: string[];
  structural_zero: string[];
}
export interface ReviewSummary {
  generated_at: string;
  stages: StageReviewStats[];
  totals: ReviewCounts & { rounds_max: number };
  skipped: { file: string; reason: string }[];
}
/** Compact form merged into work.json (§3.3-4 work ledger). */
export interface WorkReviewStats {
  updated_at: string;
  rounds: Record<string, number>;
  findings: number;
  findings_by_type: Record<string, number>;
  revised: number;
  declined: number;
  unanswered: number;
  disputed: number;
  deleted: number;
  advisory: number;
}

const emptyCounts = (): ReviewCounts => ({ rounds: 0, findings: 0, findings_by_type: {}, revised: 0, declined: 0, unanswered: 0, disputed: 0, deleted: 0, advisory: 0 });
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

// ------------------------------------------------------------------ claims (S1)
export function summarizeClaimEntries(entries: unknown[]): ReviewCounts {
  const c = emptyCounts();
  const finalOutcome = new Map<string, { review?: string; status?: string; drop_reason?: string | null }>();
  for (const e of entries as any[]) {
    if (!e || typeof e !== "object") continue;
    c.rounds = Math.max(c.rounds, num(e.round) ?? 0);
    const ids = new Set<string>(arr(e.claim_ids).map(String));
    const actions = new Map<string, string>();
    for (const a of arr(e.actions)) if (a && typeof a.claim_id === "string" && !actions.has(a.claim_id)) actions.set(a.claim_id, String(a.action));
    for (const f of arr(e.findings)) {
      if (!f) continue;
      c.findings++;
      bump(c.findings_by_type, String(f.type));
      if (f.type === "missing" || typeof f.target_id !== "string" || !ids.has(f.target_id)) continue; // not answerable per claim
      const act = actions.get(f.target_id);
      if (!act) c.unanswered++;
      else if (act === "keep") c.declined++;
      else c.revised++; // revise / drop both resolve the finding
    }
    for (const o of arr(e.outcomes)) if (o && typeof o.claim_id === "string") finalOutcome.set(o.claim_id, o);
    c.advisory += arr(e.advisory).length;
  }
  for (const o of finalOutcome.values()) {
    if (o.status === "dropped" && o.drop_reason === "copied_phrase") c.deleted++;
    else if (o.status === "active" && o.review === "disputed") c.disputed++;
  }
  return c;
}

// ------------------------------------------------------------------ layer / gen review files (S2, S3)
function summarizeRoundsObject(o: any): ReviewCounts & { max_rounds: number | null; zeroed: string[]; structural: string[] } {
  const c = emptyCounts();
  const rounds = arr(o?.rounds);
  c.rounds = num(o?.counts?.rounds) ?? rounds.length;
  const lastFor = new Map<string, any>();
  let rev = 0;
  let dec = 0;
  let una = 0;
  for (const r of rounds) {
    const resp = new Map<string, any>();
    for (const x of arr(r?.responses)) if (x && typeof x.finding_id === "string") resp.set(x.finding_id, x);
    for (const f of arr(r?.findings)) {
      if (!f) continue;
      c.findings++;
      bump(c.findings_by_type, String(f.type));
      lastFor.set(String(f.target_id), r);
      const x = resp.get(f.finding_id);
      if (!x || x.reason === NO_RESPONSE_REASON) una++;
      else if (x.action === "revised") rev++;
      else dec++;
    }
  }
  c.revised = num(o?.counts?.revised) ?? rev;
  c.declined = num(o?.counts?.declined) ?? dec;
  c.unanswered = num(o?.counts?.unanswered) ?? una;
  const sc = num(o?.status_counts?.disputed);
  if (sc !== null) c.disputed = sc;
  else if (Array.isArray(o?.unresolved)) c.disputed = o.unresolved.length;
  else {
    // M1 files: approximate from the last round that targeted each id
    for (const [target, r] of lastFor) {
      const resp = new Map<string, any>(arr(r.responses).map((x: any) => [x?.finding_id, x]));
      if (arr(r.findings).some((f: any) => String(f?.target_id) === target && (!resp.get(f.finding_id) || resp.get(f.finding_id).action !== "revised"))) c.disputed++;
    }
  }
  c.deleted = arr(o?.deleted).length;
  c.advisory = arr(o?.advisory).length;
  return {
    ...c,
    max_rounds: num(o?.max_rounds),
    zeroed: arr(o?.zeroed_types).map((z) => String(z?.type ?? z)),
    structural: arr(o?.structural_zero).map((z) => String(z?.type ?? z)),
  };
}

function addInto(t: ReviewCounts, c: ReviewCounts): void {
  t.rounds += c.rounds;
  t.findings += c.findings;
  for (const [k, v] of Object.entries(c.findings_by_type)) t.findings_by_type[k] = (t.findings_by_type[k] ?? 0) + v;
  t.revised += c.revised;
  t.declined += c.declined;
  t.unanswered += c.unanswered;
  t.disputed += c.disputed;
  t.deleted += c.deleted;
  t.advisory += c.advisory;
}

/** Read every review file of a work and compute the summary (no writes). */
export function computeReviewSummary(workDir: string, now: Date = new Date()): ReviewSummary {
  const stages: StageReviewStats[] = [];
  const skipped: ReviewSummary["skipped"] = [];
  const readFile = (rel: string): unknown | undefined => {
    try {
      return JSON.parse(readFileSync(path.join(workDir, rel), "utf8"));
    } catch (e) {
      skipped.push({ file: rel, reason: (e as Error).message.slice(0, 200) });
      return undefined;
    }
  };

  if (existsSync(path.join(workDir, CLAIMS_REVIEW_FILE))) {
    const raw = readFile(CLAIMS_REVIEW_FILE);
    if (raw !== undefined) {
      if (Array.isArray(raw)) stages.push({ stage: "s1.claims", file: CLAIMS_REVIEW_FILE, max_rounds: null, zeroed_types: [], structural_zero: [], ...summarizeClaimEntries(raw) });
      else skipped.push({ file: CLAIMS_REVIEW_FILE, reason: "not an array" });
    }
  }
  for (const { dir, prefix } of REVIEW_DIRS) {
    const abs = path.join(workDir, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).filter((n) => n.endsWith(".json")).sort()) {
      const rel = `${dir}/${name}`;
      const raw = readFile(rel);
      if (raw === undefined) continue;
      const objs = (Array.isArray(raw) ? raw : [raw]).filter((o) => o && typeof o === "object" && Array.isArray((o as any).rounds));
      if (!objs.length) {
        skipped.push({ file: rel, reason: "no rounds[]" });
        continue;
      }
      const c = emptyCounts();
      let maxRounds: number | null = null;
      const zeroed: string[] = [];
      const structural: string[] = [];
      for (const o of objs) {
        const s = summarizeRoundsObject(o);
        const prevRounds = c.rounds;
        addInto(c, s);
        c.rounds = Math.max(prevRounds, s.rounds); // several reviewed units in one file: rounds = the max, not the sum
        if (s.max_rounds !== null) maxRounds = Math.max(maxRounds ?? 0, s.max_rounds);
        zeroed.push(...s.zeroed);
        structural.push(...s.structural);
      }
      stages.push({ stage: `${prefix}.${name.replace(/\.json$/, "")}`, file: rel, max_rounds: maxRounds, zeroed_types: zeroed, structural_zero: structural, ...c });
    }
  }
  const totals = { ...emptyCounts(), rounds_max: 0 };
  for (const s of stages) {
    addInto(totals, s);
    totals.rounds_max = Math.max(totals.rounds_max, s.rounds);
  }
  return { generated_at: now.toISOString(), stages, totals, skipped };
}

export function compactStats(s: ReviewSummary): WorkReviewStats {
  return {
    updated_at: s.generated_at,
    rounds: Object.fromEntries(s.stages.map((x) => [x.stage, x.rounds])),
    findings: s.totals.findings,
    findings_by_type: s.totals.findings_by_type,
    revised: s.totals.revised,
    declined: s.totals.declined,
    unanswered: s.totals.unanswered,
    disputed: s.totals.disputed,
    deleted: s.totals.deleted,
    advisory: s.totals.advisory,
  };
}

/**
 * Compute and write nkg/review_summary.json, and merge `review_stats` into work.json (other fields untouched;
 * skipped when work.json does not exist). Returns the summary and the written path (relative to workDir).
 */
export function summarizeReviews(workDir: string, now: Date = new Date()): { summary: ReviewSummary; output: string; workUpdated: boolean } {
  const summary = computeReviewSummary(workDir, now);
  const output = writeJson(workDir, REVIEW_SUMMARY_FILE, summary);
  let workUpdated = false;
  if (existsSync(path.join(workDir, "work.json"))) {
    const w = readWork(workDir) as Work & { review_stats?: WorkReviewStats };
    writeWork(workDir, { ...w, review_stats: compactStats(summary) } as Work);
    workUpdated = true;
  }
  return { summary, output, workUpdated };
}
