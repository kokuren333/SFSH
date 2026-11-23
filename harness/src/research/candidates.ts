import type { WebSearchEvent } from "../model/types.ts";
import type { Candidate, CandidateOrigin, ResearchGap, Tier } from "./types.ts";

/**
 * §1.3-1: candidate URLs come only from web_search events (or the instruction input).
 * A URL Luna returns that does not appear in any search result of the same call is "self-reported"
 * and is rejected. Shared by S1 search (WP-1.3) and S0 identification (WP-1.6). Orchestrator-owned.
 */

/** Lenient key for "is this the same page?" matching (not the source_id — the fetcher owns that). */
export function urlMatchKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let p = u.pathname;
  try {
    p = decodeURI(p);
  } catch {
    /* keep raw */
  }
  p = p.replace(/\/+$/, "");
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !/^(utm_|fbclid$|gclid$)/i.test(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
  return `${host}${p}${params ? "?" + params : ""}`;
}

export interface SearchCallRecord {
  call_id: string;
  task: string;
  at: string;
  queries: string[];
  results: { url: string; title: string; domain: string; snippet: string; item_id: string }[];
  /** open_page actions seen in the events. verified=false unless the harness passed that URL (§1.3-4). */
  open_pages: { url: string; verified: boolean }[];
}

/** Summarise one search call's events for research/search_log.json. */
export function recordSearchCall(
  callId: string,
  task: string,
  at: string,
  events: WebSearchEvent[],
  verifiedOpenPageUrls: string[] = [],
): SearchCallRecord {
  const verified = new Set(verifiedOpenPageUrls.map((u) => urlMatchKey(u)).filter((k): k is string => !!k));
  const queries: string[] = [];
  const results: SearchCallRecord["results"] = [];
  const open_pages: SearchCallRecord["open_pages"] = [];
  for (const e of events) {
    if (e.action === "search" && e.query) queries.push(e.query);
    if (e.action === "open_page" && e.url) open_pages.push({ url: e.url, verified: verified.has(urlMatchKey(e.url) ?? "") });
    for (const r of e.results) results.push({ ...r, item_id: e.itemId });
  }
  return { call_id: callId, task, at, queries, results, open_pages };
}

export interface ModelSelection {
  url: string;
  why?: string;
  aspects?: string[];
  tier_suggested?: Tier | null;
}

export interface CandidateFilterResult {
  selected: Candidate[];
  rejected: { url: string; reason: "self_reported" | "invalid_url" | "duplicate_selection"; why?: string }[];
  gaps: ResearchGap[];
}

/**
 * Keep only selections whose URL appears in this call's search results (or in `instructionUrls`).
 * The candidate carries the URL string exactly as it appeared in the event (not Luna's rewrite).
 */
export function filterSelections(
  selections: ModelSelection[],
  call: SearchCallRecord,
  at: string,
  instructionUrls: { url: string; note: string }[] = [],
): CandidateFilterResult {
  const byKey = new Map<string, { url: string; title: string; item_id: string; query: string | null }>();
  for (const r of call.results) {
    const k = urlMatchKey(r.url);
    if (k && !byKey.has(k)) byKey.set(k, { url: r.url, title: r.title, item_id: r.item_id, query: null });
  }
  const instr = new Map<string, { url: string; note: string }>();
  for (const i of instructionUrls) {
    const k = urlMatchKey(i.url);
    if (k) instr.set(k, i);
  }
  const selected: Candidate[] = [];
  const rejected: CandidateFilterResult["rejected"] = [];
  const gaps: ResearchGap[] = [];
  const seen = new Set<string>();
  for (const s of selections) {
    const k = urlMatchKey(s.url);
    if (!k) {
      rejected.push({ url: s.url, reason: "invalid_url", why: s.why });
      continue;
    }
    if (seen.has(k)) {
      rejected.push({ url: s.url, reason: "duplicate_selection" });
      continue;
    }
    seen.add(k);
    const hit = byKey.get(k);
    const ins = instr.get(k);
    let origin: CandidateOrigin;
    let url: string;
    let title: string | undefined;
    if (hit) {
      origin = { kind: "search_event", callId: call.call_id, itemId: hit.item_id, query: call.queries.length === 1 ? call.queries[0] : null };
      url = hit.url;
      title = hit.title;
    } else if (ins) {
      origin = { kind: "instruction", note: ins.note };
      url = ins.url;
    } else {
      rejected.push({ url: s.url, reason: "self_reported", why: s.why });
      gaps.push({ kind: "self_reported_url", url: s.url, detail: "URL not present in this call's web_search results; not used (§1.3-1)", at });
      continue;
    }
    selected.push({
      url,
      origin,
      title,
      why: s.why,
      tierSuggested: s.tier_suggested ?? undefined,
      aspects: s.aspects,
    });
  }
  for (const op of call.open_pages) {
    if (!op.verified) {
      gaps.push({ kind: "unverified_open_page", url: op.url, detail: "open_page on a URL the harness did not pass; recorded as advisory, not used as evidence (§1.3-4)", at });
    }
  }
  return { selected, rejected, gaps };
}
