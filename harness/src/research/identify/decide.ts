/**
 * S0 deterministic decision rules (§4.6-3..5). No model calls here: the model proposes, this code decides.
 */
import { findQuote, normalizeForMatch, normKey, type NormalizedText } from "../textMatch.ts";
import type { SourceCard } from "../types.ts";
import { kataToHira } from "../../works/slug.ts";
import type { ExtractedCandidate, IdentifyMedium } from "./prompts.ts";

export interface LoadedSource {
  card: SourceCard;
  text: NormalizedText;
}

export interface VerifiedEvidence {
  source_id: string;
  offset: number;
  length: number;
}

export interface VerifiedAlias {
  text: string;
  kind: "official_alt" | "common";
  source_ids: string[];
}

export interface VerifiedCandidate {
  title: string;
  title_original: string | null;
  title_reading: string | null;
  medium: IdentifyMedium;
  creators: string[];
  first_release_year: number | null;
  evidence: VerifiedEvidence[];
  aliases: VerifiedAlias[];
}

export interface DroppedCandidate {
  title: string;
  medium: string;
  reason: "no_verified_evidence" | "empty_title";
}

export interface VerifyResult {
  kept: VerifiedCandidate[];
  dropped: DroppedCandidate[];
  evidenceTotal: number;
  evidenceDropped: number;
  aliasesDropped: number;
}

/**
 * Keep an evidence item only if the quote is found verbatim (normalized) in the saved text of a fetched card
 * AND the quote contains the candidate title. Candidates with no verified evidence are dropped (C-7).
 * aliases_seen are checked the same way (quote must contain the alias text and be found in the source).
 */
export function verifyCandidates(raw: ExtractedCandidate[], sources: Map<string, LoadedSource>): VerifyResult {
  const kept: VerifiedCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  let evidenceTotal = 0;
  let evidenceDropped = 0;
  let aliasesDropped = 0;
  for (const c of raw) {
    const title = (c.title ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    const tKey = normKey(title);
    evidenceTotal += c.evidence.length;
    if (tKey.length < 1) {
      dropped.push({ title, medium: c.medium, reason: "empty_title" });
      evidenceDropped += c.evidence.length;
      continue;
    }
    const evidence: VerifiedEvidence[] = [];
    for (const e of c.evidence) {
      const src = sources.get(e.source_id);
      const hit = src && normKey(e.quote).includes(tKey) ? findQuote(src.text, e.quote) : null;
      if (!src || !hit) {
        evidenceDropped++;
        continue;
      }
      if (!evidence.some((v) => v.source_id === e.source_id && v.offset === hit.offset)) {
        evidence.push({ source_id: e.source_id, offset: hit.offset, length: hit.length });
      }
    }
    const aliases: VerifiedAlias[] = [];
    for (const a of c.aliases_seen) {
      const text = a.text.normalize("NFKC").trim().replace(/\s+/gu, " ");
      const aKey = normKey(text);
      const src = sources.get(a.source_id);
      const ok = src && aKey.length >= 2 && aKey !== tKey && normKey(a.quote).includes(aKey) && findQuote(src.text, a.quote);
      if (!ok) {
        aliasesDropped++;
        continue;
      }
      const prev = aliases.find((x) => normKey(x.text) === aKey);
      if (prev) {
        if (!prev.source_ids.includes(a.source_id)) prev.source_ids.push(a.source_id);
        if (a.kind === "official_alt") prev.kind = "official_alt";
      } else aliases.push({ text, kind: a.kind, source_ids: [a.source_id] });
    }
    if (evidence.length === 0) {
      dropped.push({ title, medium: c.medium, reason: "no_verified_evidence" });
      continue;
    }
    kept.push({
      title,
      title_original: c.title_original?.trim() || null,
      title_reading: normalizeReading(c.title_reading),
      medium: c.medium,
      creators: uniq(c.creators.map((x) => x.trim()).filter(Boolean)),
      first_release_year: c.first_release_year ?? null,
      evidence,
      aliases,
    });
  }
  return { kept, dropped, evidenceTotal, evidenceDropped, aliasesDropped };
}

/** Group by normKey(title) + medium: merge evidence / aliases / creators, earliest year, first non-null text fields. */
export function groupCandidates(list: VerifiedCandidate[]): VerifiedCandidate[] {
  const groups = new Map<string, VerifiedCandidate>();
  for (const c of list) {
    const k = `${normKey(c.title)}|${c.medium}`;
    const g = groups.get(k);
    if (!g) {
      groups.set(k, { ...c, evidence: [...c.evidence], aliases: c.aliases.map((a) => ({ ...a, source_ids: [...a.source_ids] })), creators: [...c.creators] });
      continue;
    }
    for (const e of c.evidence) if (!g.evidence.some((v) => v.source_id === e.source_id && v.offset === e.offset)) g.evidence.push(e);
    for (const a of c.aliases) {
      const prev = g.aliases.find((x) => normKey(x.text) === normKey(a.text));
      if (!prev) g.aliases.push({ ...a, source_ids: [...a.source_ids] });
      else {
        prev.source_ids = uniq([...prev.source_ids, ...a.source_ids]);
        if (a.kind === "official_alt") prev.kind = "official_alt";
      }
    }
    g.creators = uniq([...g.creators, ...c.creators]);
    g.title_original ??= c.title_original;
    g.title_reading ??= c.title_reading;
    if (c.first_release_year !== null && (g.first_release_year === null || c.first_release_year < g.first_release_year)) {
      g.first_release_year = c.first_release_year;
    }
  }
  return [...groups.values()];
}

const MEDIUM_SYNONYMS: Record<string, IdentifyMedium> = {
  movie: "film",
  cinema: "film",
  comic: "manga",
  comics: "manga",
  light_novel: "novel",
  lightnovel: "novel",
  tv: "drama",
  videogame: "game",
};

export function normalizeMediumHint(hint: string | null): string | null {
  if (!hint) return null;
  const h = hint.trim().toLowerCase();
  if (!h) return null;
  return MEDIUM_SYNONYMS[h] ?? h;
}

/** Apply medium_hint as a filter only when it narrows the set to ≥1 (a hint that matches nothing is ignored). */
export function applyMediumHint<T extends { medium: string }>(list: T[], hint: string | null): { list: T[]; applied: boolean } {
  const h = normalizeMediumHint(hint);
  if (!h) return { list, applied: false };
  const f = list.filter((c) => c.medium === h);
  if (f.length > 0 && f.length < list.length) return { list: f, applied: true };
  return { list, applied: false };
}

/** §4.6-5: confirmed iff ≥1 T1 card, or ≥2 T2 cards with distinct site_key, among the verified evidence. */
export function decideTitleStatus(evidence: VerifiedEvidence[], cards: Map<string, SourceCard>): "confirmed" | "provisional" {
  const ids = uniq(evidence.map((e) => e.source_id));
  const evCards = ids.map((id) => cards.get(id)).filter((c): c is SourceCard => !!c);
  if (evCards.some((c) => c.tier === "T1")) return "confirmed";
  const t2Sites = new Set(evCards.filter((c) => c.tier === "T2").map((c) => c.site_key));
  return t2Sites.size >= 2 ? "confirmed" : "provisional";
}

/** Hiragana reading: NFKC, katakana folded to hiragana, whitespace collapsed. Empty → null. */
export function normalizeReading(r: string | null | undefined): string | null {
  if (!r) return null;
  const s = kataToHira(r.normalize("NFKC")).trim().replace(/\s+/gu, " ");
  return s || null;
}

/** "source" when the reading (spaces ignored) appears in any fetched text; katakana renderings count too. */
export function readingBasis(reading: string | null, sources: Iterable<LoadedSource>): "source" | "estimated" {
  if (!reading) return "estimated";
  const hira = normKey(reading);
  if (hira.length < 2) return "estimated";
  const kata = [...hira].map((ch) => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0x3041 && cp <= 0x3096 ? String.fromCodePoint(cp + 0x60) : ch;
  }).join("");
  for (const s of sources) if (s.text.norm.includes(hira) || s.text.norm.includes(kata)) return "source";
  return "estimated";
}

/**
 * Is `notation` attested in a source text as a name of its own? Occurrences inside the title itself are masked
 * first, so a substring of the title (e.g. "まどか☆マギカ" inside "魔法少女まどか☆マギカ") does not count.
 * Returns the source_ids where it occurs.
 */
export function attestingSources(notation: string, title: string, sources: Iterable<LoadedSource>): string[] {
  const nKey = normKey(notation);
  if (nKey.length < 2) return [];
  const tKey = normKey(title);
  const out: string[] = [];
  for (const s of sources) {
    let norm = s.text.norm;
    if (tKey && tKey !== nKey && tKey.includes(nKey)) norm = norm.split(tKey).join("\u0000");
    if (norm.includes(nKey)) out.push(s.card.source_id);
  }
  return out.sort();
}

export function loadSource(card: SourceCard, rawText: string): LoadedSource {
  return { card, text: normalizeForMatch(rawText) };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
