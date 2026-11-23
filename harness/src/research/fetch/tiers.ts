import { readFileSync } from "node:fs";
import type { Candidate, SourceCard, Tier } from "../types.ts";

export interface SourceTierEntry { pattern: string; tier: Tier; license: string | null; note: string }

export function loadSourceTiers(injected?: SourceTierEntry[]): SourceTierEntry[] {
  return injected ?? JSON.parse(readFileSync(new URL("../../../config/source_tiers.json", import.meta.url), "utf8"));
}

export function resolveTier(url: string, candidate: Pick<Candidate, "tierSuggested"> = {}, table = loadSourceTiers()):
  Pick<SourceCard, "tier" | "tier_basis" | "license"> {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  const entry = table.find(({ pattern }) => host === pattern || host.endsWith("." + pattern));
  if (entry) return { tier: entry.tier, tier_basis: "table", license: entry.license };
  return candidate.tierSuggested
    ? { tier: candidate.tierSuggested, tier_basis: "model_suggested", license: null }
    : { tier: "T4", tier_basis: "default", license: null };
}

export function siteKey(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const tld = labels.at(-1)!;
  const second = labels.at(-2) ?? "";
  const grouped = tld === "jp" ? ["co", "ne", "or", "ac", "go", "ed", "gr", "lg", "ad"].includes(second)
    : tld.length === 2 && ["co", "ac", "gov", "org"].includes(second);
  return labels.slice(grouped ? -3 : -2).join(".");
}
