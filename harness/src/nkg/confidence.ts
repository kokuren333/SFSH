/**
 * Deterministic confidence (REQUIREMENTS §2.3). Never uses model self-reports.
 *
 * - Independence = distinct site_key. A higher tier also counts toward lower-tier thresholds.
 * - A: ≥1 T1, or ≥2 independent sources of T2 or better
 * - B: ≥1 source of T2 or better, or ≥2 independent sources of T3 or better
 * - C: ≥1 source of T3 or better, or ≥2 distinct sources of T4 or better
 * - D: everything else (T5-only never rises above D)
 * - review "disputed" lowers the grade by one step (D stays D).
 */
import type { Confidence, Grade, ProvenanceItem, ReviewState, Tier } from "./types.ts";

export const GRADE_SCORE: Record<Grade, number> = { A: 0.9, B: 0.7, C: 0.5, D: 0.3 };
export const GRADE_ORDER: Grade[] = ["A", "B", "C", "D"];
const TIERS: Tier[] = ["T1", "T2", "T3", "T4", "T5"];

/** Minimal source shape confidence needs (SourceCard and NkgSource both fit). */
export interface TieredSource {
  source_id: string;
  tier: Tier;
  site_key: string;
}

const rank = (t: Tier): number => TIERS.indexOf(t) + 1;

export function gradeFromSources(sources: TieredSource[]): Grade {
  const atLeast = (maxRank: number) => sources.filter((s) => rank(s.tier) <= maxRank);
  const sites = (list: TieredSource[]) => new Set(list.map((s) => s.site_key)).size;
  const ids = (list: TieredSource[]) => new Set(list.map((s) => s.source_id)).size;
  if (atLeast(1).length >= 1 || sites(atLeast(2)) >= 2) return "A";
  if (atLeast(2).length >= 1 || sites(atLeast(3)) >= 2) return "B";
  if (atLeast(3).length >= 1 || ids(atLeast(4)) >= 2) return "C";
  return "D";
}

export function lowerGrade(g: Grade): Grade {
  return GRADE_ORDER[Math.min(GRADE_ORDER.indexOf(g) + 1, GRADE_ORDER.length - 1)];
}

export function computeConfidence(
  provenance: ProvenanceItem[],
  sourcesById: ReadonlyMap<string, TieredSource> | Record<string, TieredSource>,
  review: ReviewState | null | undefined,
): Confidence {
  const lookup = (id: string): TieredSource | undefined =>
    sourcesById instanceof Map ? sourcesById.get(id) : (sourcesById as Record<string, TieredSource>)[id];
  const seen = new Set<string>();
  const sources: TieredSource[] = [];
  for (const p of provenance) {
    if (seen.has(p.source_id)) continue;
    const s = lookup(p.source_id);
    if (!s) continue;
    seen.add(p.source_id);
    sources.push(s);
  }
  let grade = gradeFromSources(sources);
  const counts = TIERS.map((t) => [t, sources.filter((s) => s.tier === t).length] as const).filter(([, n]) => n > 0);
  const siteCount = new Set(sources.map((s) => s.site_key)).size;
  let basis = counts.length ? `${counts.map(([t, n]) => `${t}×${n}`).join(", ")} (sites: ${siteCount})` : "no sources (sites: 0)";
  if (review === "disputed") {
    grade = lowerGrade(grade);
    basis += "; disputed −1";
  }
  return { score: GRADE_SCORE[grade], grade, basis };
}

export function gradeAtLeast(g: Grade, min: Grade): boolean {
  return GRADE_ORDER.indexOf(g) <= GRADE_ORDER.indexOf(min);
}
