/**
 * Deterministic text matching on saved source text (orchestrator-owned, shared by WP-1.3 / WP-1.6 / M3 A-1).
 * Normalization = NFKC + whitespace removal, with a map back to offsets in the original text.
 */

export interface NormalizedText {
  /** The original text. */
  orig: string;
  norm: string;
  /** map[i] = offset in the original string of norm[i]. */
  map: number[];
}

export function normalizeForMatch(s: string): NormalizedText {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const n = ch.normalize("NFKC");
    for (const c of n) {
      if (/\s/u.test(c)) continue;
      norm += c;
      for (let k = 0; k < c.length; k++) map.push(i);
    }
    i += ch.length;
  }
  return { orig: s, norm, map };
}

export function normKey(s: string): string {
  return normalizeForMatch(s).norm;
}

/**
 * Find `quote` inside `text` after normalization on both sides.
 * Returns the span in the ORIGINAL text, or null. Empty/1-char quotes never match.
 */
export function findQuote(text: string | NormalizedText, quote: string): { offset: number; length: number } | null {
  const t = typeof text === "string" ? normalizeForMatch(text) : text;
  const q = normKey(quote);
  if (q.length < 2) return null;
  const idx = t.norm.indexOf(q);
  if (idx < 0) return null;
  const start = t.map[idx];
  const lastStart = t.map[idx + q.length - 1];
  const cp = t.orig.codePointAt(lastStart)!;
  const end = lastStart + (cp > 0xffff ? 2 : 1);
  return { offset: start, length: end - start };
}

/** Set of all `n`-char windows of a normalized text (for copy detection). */
export function windows(norm: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= norm.length; i++) out.add(norm.slice(i, i + n));
  return out;
}

/**
 * Longest common contiguous run (in normalized chars) between `candidate` and `source`, computed
 * only up to `threshold` (returns ≥ threshold as soon as one window of that length matches).
 * Used for the 30-char verbatim rule (§5.1 A-1 / copied_phrase).
 */
export function hasVerbatimRun(candidate: string, sourceWindows: Set<string>, threshold: number): boolean {
  const c = normKey(candidate);
  for (let i = 0; i + threshold <= c.length; i++) {
    if (sourceWindows.has(c.slice(i, i + threshold))) return true;
  }
  return false;
}
