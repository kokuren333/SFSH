/**
 * S4 automatic check (REQUIREMENTS §5.1, §5.2; logs/m3/PLAN.md "共有契約"): report types and parameters.
 * The report (works/<id>/check/report.json) is internal. It never contains matched source / generated text —
 * only sha256 prefixes (16 hex) and character counts.
 */

/** §5.1 A-1 [暫定]: continuous verbatim run (normalized chars, proper nouns excluded). */
export const A1_RUN = 30;
/** §5.2 [暫定]: long quote = contents of 「」『』 ≥ 20 normalized chars. */
export const LONG_QUOTE_CHARS = 20;
/** §5.2 [暫定]: similarity advisory = 3-gram Jaccard > 0.5 on sentences ≥ 15 normalized chars. */
export const SIMILARITY = { ngram: 3, jaccard_gt: 0.5, min_chars: 15 } as const;

export const CHECK_FILES = {
  report: "check/report.json",
  before: "check/public.before.json",
} as const;

export type Author = "haiku" | "luna";
export type AuthorBasis = "nkg" | "pages" | "fallback";

export interface A1Detected {
  path: string;
  element_id: string | null;
  author: Author;
  author_basis: AuthorBasis;
  sentence_sha256: string;
  chars: number;
}

export type RemovalAction = "sentence_removed" | "field_nulled" | "entry_removed" | "element_removed";

export interface RemovedEntry {
  path: string;
  element_id: string | null;
  action: RemovalAction;
  /** sha256 prefix of the removed sentence (sentence_removed) or of the whole original field value (field actions). */
  sentence_sha256: string;
}

export interface CascadeEntry {
  path: string;
  id: string;
  reason: string;
}

export type A2Kind = "data_uri" | "media_url" | "html_media_tag" | "markdown_image" | "css_url" | "embed_url";

export interface A2Detected {
  path: string;
  kind: A2Kind;
  sha256: string;
}

export const ADVISORY_TYPES = [
  "long_quote",
  "similar_to_source",
  "too_concrete_unresolved",
  "short_or_lyric_work",
  "holder_policy",
  "title_provisional",
  "over_guideline",
  "chain_dropout",
] as const;
export type AdvisoryType = (typeof ADVISORY_TYPES)[number];

export interface AdvisoryItem {
  type: AdvisoryType;
  /** Path, element id, or "work". */
  target: string;
  /** Short description; never copies source or generated text. */
  detail: string;
  /** too_concrete_unresolved only: whether the target element is still in the public file. */
  in_public?: boolean;
}

export interface RewriteStat {
  calls: number;
  items: number;
  failed: boolean;
}

export interface CheckReport {
  schema: "sfsh-check/1";
  work_id: string;
  job_id: string;
  checked_at: string;
  /** Always false (P-1). */
  blocking: false;
  a1: {
    threshold: number;
    sources_checked: number;
    sources_missing: string[];
    allowlist_terms: number;
    texts_scanned: number;
    detected: A1Detected[];
    rewrite: { haiku: RewriteStat; luna: RewriteStat };
    rewritten_ok: number;
    removed: RemovedEntry[];
    cascade_removed: CascadeEntry[];
    residual_after_fix: number;
  };
  a2: {
    detected: A2Detected[];
    removed: number;
    residual_after_fix: number;
    /** Field-level consequences of A-2 removals (a value emptied by A-2). Superset of the PLAN contract. */
    field_actions: RemovedEntry[];
    cascade_removed: CascadeEntry[];
  };
  advisory: AdvisoryItem[];
  advisory_counts: Record<AdvisoryType, number>;
  params: {
    a1_run: number;
    long_quote_chars: number;
    similarity: { ngram: number; jaccard_gt: number; min_chars: number };
  };
  notice: { line: string; points: string[] };
}
