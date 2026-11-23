/** File layout and small readers for S3 (works/<id>/gen/). All paths relative to the work dir. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../paths.ts";
import { readJson } from "../nkg/io.ts";
import type { Nkg, Spoiler } from "../nkg/types.ts";
import type { NkgValidation } from "../nkg/validate.ts";

export const GEN_FILES = {
  tags: "gen/tags.json",
  projection: "gen/projection.json",
  page: (page: string) => `gen/pages/${page}.json`,
  reviewPages: "gen/reviews/pages.json",
  writeReport: "gen/write_report.json",
  /** AMENDMENT 11: long spoiler synopsis (gen/pages/synopsis.json + gen/reviews/synopsis.json + this report). */
  synopsisReport: "gen/synopsis_report.json",
  reviewSynopsis: "gen/reviews/synopsis.json",
  public: "gen/public.json",
  genCheck: "gen/gen_check.json",
} as const;

/** Internal page files written by writePages (one per page key). */
export const PAGE_KEYS = ["overview", "figure_notes", "themes", "context", "interpretations", "quiz", "synopsis"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export interface VocabEntry {
  slug: string;
  label: string;
  group?: string;
}

function loadVocab(file: string, key: "tags" | "genres"): VocabEntry[] {
  const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, "harness", "config", file), "utf8")) as Record<string, VocabEntry[]>;
  return (raw[key] ?? []).map((v) => ({ slug: v.slug, label: v.label, ...(v.group ? { group: v.group } : {}) }));
}
export const loadTagVocab = (): VocabEntry[] => loadVocab("tags.json", "tags");
export const loadGenreVocab = (): VocabEntry[] => loadVocab("genres.json", "genres");
export const tagVocabVersion = (): number => Number((JSON.parse(readFileSync(path.join(REPO_ROOT, "harness", "config", "tags.json"), "utf8")) as { version?: number }).version ?? 0);

/** Max tags per work (§6.5 [暫定]). */
export const MAX_TAGS = 8;

export const SPOILER_RANK: Record<Spoiler, number> = { none: 0, mid: 1, ending: 2 };
export function maxSpoiler(...xs: (Spoiler | null | undefined)[]): Spoiler {
  let best: Spoiler = "none";
  for (const x of xs) if (x && SPOILER_RANK[x] > SPOILER_RANK[best]) best = x;
  return best;
}

export function readNkg(workDir: string): Nkg {
  const nkg = readJson<Nkg | null>(workDir, "nkg/nkg.json", null);
  if (!nkg) throw new Error("S3: nkg/nkg.json missing — run S2 first");
  return nkg;
}

export function readValidation(workDir: string): NkgValidation {
  const v = readJson<NkgValidation | null>(workDir, "nkg/validation.json", null);
  if (!v) throw new Error("S3: nkg/validation.json missing — run S2 assemble first");
  return v;
}

/** gen/tags.json `final` (vocab-filtered, ≤ 8) or [] when tags were not suggested yet. */
export function readFinalTags(workDir: string, vocab: VocabEntry[] = loadTagVocab()): string[] {
  const f = readJson<{ final?: unknown } | null>(workDir, GEN_FILES.tags, null);
  const allowed = new Set(vocab.map((v) => v.slug));
  const out: string[] = [];
  for (const t of Array.isArray(f?.final) ? f.final : []) if (typeof t === "string" && allowed.has(t) && !out.includes(t)) out.push(t);
  return out.slice(0, MAX_TAGS);
}

/** Claim ids behind an element (provenance locators "claim:c0001"). */
export function claimIdsOf(prov: { locator?: string }[] | undefined): string[] {
  const out: string[] = [];
  for (const p of prov ?? []) {
    for (const m of String(p?.locator ?? "").matchAll(/c\d{4,}/g)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
