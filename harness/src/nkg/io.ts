/** Small file helpers for the S2 (NKG) stages. All paths are relative to the work dir. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Claim } from "../research/claimTypes.ts";
import type { SourceCard } from "../research/types.ts";
import type { NkgSource } from "./types.ts";

export const NKG_FILES = {
  moduleSelection: "nkg/module_selection.json",
  phases: "nkg/phases.json",
  factLayer: "nkg/layers/fact.json",
  interpLayer: "nkg/layers/interp.json",
  nkg: "nkg/nkg.json",
  validation: "nkg/validation.json",
  buildReport: "nkg/build_report.json",
  review: (layer: string) => `nkg/reviews/${layer}.json`,
} as const;

export function readJson<T>(workDir: string, rel: string, fallback: T): T {
  const abs = path.join(workDir, rel);
  if (!existsSync(abs)) return fallback;
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

export function writeJson(workDir: string, rel: string, data: unknown): string {
  const abs = path.join(workDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, abs);
  return rel;
}

/** research/claims.json is Claim[] (PLAN §1); tolerate a { claims: [] } wrapper. */
export function readActiveClaims(workDir: string): Claim[] {
  const raw = readJson<unknown>(workDir, "research/claims.json", []);
  const list = (Array.isArray(raw) ? raw : ((raw as { claims?: unknown[] })?.claims ?? [])) as Claim[];
  return list.filter((c) => c && c.status === "active");
}

export function readSourceCards(workDir: string): SourceCard[] {
  const raw = readJson<unknown>(workDir, "research/sources.json", []);
  return (Array.isArray(raw) ? raw : ((raw as { sources?: unknown[] })?.sources ?? [])) as SourceCard[];
}

/** Bibliographic subset of a source card for nkg.sources (no excerpt text — C-2). */
export function toNkgSource(c: SourceCard): NkgSource {
  return {
    source_id: c.source_id,
    url: c.url,
    title: c.title ?? "",
    publisher: c.publisher ?? "",
    tier: c.tier,
    site_key: c.site_key || c.domain || c.source_id,
    license: c.license ?? null,
    fetched_at: c.fetched_at ?? "",
  };
}

/** Claims restricted to those whose sources have cards, keyed by id. */
export function claimIndex(claims: Claim[], cards: SourceCard[]): Map<string, Claim> {
  const have = new Set(cards.map((c) => c.source_id));
  const out = new Map<string, Claim>();
  for (const c of claims) {
    const sids = (c.source_ids ?? []).filter((s) => have.has(s));
    if (sids.length) out.set(c.claim_id, { ...c, source_ids: sids });
  }
  return out;
}
