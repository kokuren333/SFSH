/** Work ledger types (REQUIREMENTS §4.6 work.json / INDEX.json title fields, §1.4). */

export type AliasKind = "official_alt" | "common" | "input";

export interface WorkAlias {
  /** ≤ 80 chars, one line. */
  text: string;
  kind: AliasKind;
  /** Confirmed in a saved source of this work. */
  attested: boolean;
  source_ids: string[];
  origin_job_id: string;
  first_seen: string;
}

export type WorkMedium = "novel" | "manga" | "anime" | "film" | "drama" | "game" | "other";

export interface WorkHistoryEntry {
  at: string;
  /** e.g. "created", "merged", "alias_added", "title_confirmed", "title_changed". */
  event: string;
  job_id: string | null;
  detail?: string;
  /** Owner operations (§5.3: hold/release/takedown/purge): who ran it, e.g. "owner(cli)". */
  actor?: string;
  /** Owner operations: the stated reason (omitted when none was given). */
  reason?: string;
}

export interface Work {
  work_id: string;
  title: string;
  title_original: string | null;
  /** Hiragana reading with spaces between words (sort / search only; never displayed as fact). */
  title_reading: string | null;
  title_reading_basis: "source" | "estimated";
  title_status: "confirmed" | "provisional";
  title_source_ids: string[];
  aliases: WorkAlias[];
  medium: string;
  creators: string[];
  genres: string[];
  tags: string[];
  first_release_year: number | null;
  publish_mode: "Public" | "Restricted";
  history: WorkHistoryEntry[];
  first_published_at: string | null;
  updated_at: string | null;
  created_at: string;
  /** S3 compose (gen/): catalog fields mirrored from gen/public.json (§6.5). Optional: absent before the first compose. */
  status?: "completed" | "ongoing" | "unknown";
  coverage_label?: string;
  spoiler_max?: "none" | "mid" | "ending";
  has_matrix?: boolean;
  /**
   * AMENDMENT 15: the last run's candidate did not meet an `enforce` requirement after the repairs ("built, publish
   * held"). gen/public.json holds the previous published version (or is absent for a work never published) and the
   * candidate waits in gen/public.held.json until `sfsh release <work_id>` (or a later run that conforms).
   */
  conformance_hold?: ConformanceHold | null;
}

export interface ConformanceHold {
  job_id: string;
  at: string;
  /** enforce items still short after the repairs */
  items: string[];
  /** one line per shortfall (Japanese, for notices) */
  shortfalls: string[];
  report: string;
  /** what gen/public.json holds while held */
  public_json: "previous_published" | "absent";
}

/** One INDEX.json entry: exactly the §4.6 fields. */
export interface IndexEntry {
  work_id: string;
  title: string;
  title_original: string | null;
  title_reading: string | null;
  title_status: "confirmed" | "provisional";
  aliases: WorkAlias[];
  medium: string;
  creators: string[];
  genres: string[];
  tags: string[];
  publish_mode: string;
  first_published_at: string | null;
  updated_at: string | null;
}

export interface WorksIndex {
  works: IndexEntry[];
}

export const INDEX_FIELDS = [
  "work_id",
  "title",
  "title_original",
  "title_reading",
  "title_status",
  "aliases",
  "medium",
  "creators",
  "genres",
  "tags",
  "publish_mode",
  "first_published_at",
  "updated_at",
] as const satisfies readonly (keyof IndexEntry)[];
