import { normalizeQuery } from "../research/identify/normalize.ts";
import type { AliasKind, Work, WorkAlias } from "./types.ts";

export const ALIAS_MAX_CHARS = 80;

const KIND_RANK: Record<AliasKind, number> = { input: 0, common: 1, official_alt: 2 };

export type AddAliasOutcome = "added" | "merged" | "unchanged" | "skipped";

/**
 * §4.6-6: add an alias to work.aliases (mutates `work`).
 *  - text is normalized (normalizeQuery, one line); > 80 chars or equal to the title → "skipped".
 *  - duplicates (same normalized key) merge: attested = OR, source_ids = union, kind = the stronger one
 *    (official_alt > common > input); an attested `input` is upgraded to `common`.
 *    The first text / origin_job_id / first_seen are kept.
 *  - never deletes (deletion is an owner operation).
 */
export function addAlias(work: Work, alias: WorkAlias): AddAliasOutcome {
  const text = normalizeQuery(alias.text);
  if (!text || text.length > ALIAS_MAX_CHARS) return "skipped";
  if (text === normalizeQuery(work.title)) return "skipped";
  const sourceIds = [...new Set(alias.source_ids)].sort();
  const attested = alias.attested || false;
  const existing = work.aliases.find((a) => normalizeQuery(a.text) === text);
  if (!existing) {
    work.aliases.push({
      text,
      kind: alias.kind === "input" && attested ? "common" : alias.kind,
      attested,
      source_ids: sourceIds,
      origin_job_id: alias.origin_job_id,
      first_seen: alias.first_seen,
    });
    return "added";
  }
  const before = JSON.stringify(existing);
  existing.attested = existing.attested || attested;
  existing.source_ids = [...new Set([...existing.source_ids, ...sourceIds])].sort();
  if (KIND_RANK[alias.kind] > KIND_RANK[existing.kind]) existing.kind = alias.kind;
  if (existing.kind === "input" && existing.attested) existing.kind = "common";
  return JSON.stringify(existing) === before ? "unchanged" : "merged";
}

export function hasAlias(work: Work, text: string): boolean {
  const k = normalizeQuery(text);
  return work.aliases.some((a) => normalizeQuery(a.text) === k);
}
