import type { IndexEntry, WorksIndex } from "../../works/types.ts";

/** §4.6-1 lookup key: NFKC, trim, collapse internal whitespace to one ASCII space. work_query itself is never rewritten. */
export function normalizeQuery(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * §4.6-2: compare the key against title / title_original / title_reading / aliases[].text of every INDEX entry,
 * each normalized with normalizeQuery. Returns the matching work_ids (0, 1 or many), sorted.
 */
export function matchIndex(key: string, index: WorksIndex | IndexEntry[]): string[] {
  const k = normalizeQuery(key);
  if (!k) return [];
  const entries = Array.isArray(index) ? index : index.works;
  const hits = new Set<string>();
  for (const e of entries) {
    const names = [e.title, e.title_original, e.title_reading, ...(e.aliases ?? []).map((a) => a.text)];
    if (names.some((n) => typeof n === "string" && n && normalizeQuery(n) === k)) hits.add(e.work_id);
  }
  return [...hits].sort();
}
