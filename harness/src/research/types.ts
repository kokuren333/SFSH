/**
 * Shared S0/S1 research contracts (M1). Fixed by the orchestrator (CP-016) so WP-1.2 (fetcher),
 * WP-1.3 (claims) and WP-1.6 (identification) can be built in parallel. Change only via the orchestrator.
 *
 * REQUIREMENTS v1.3 §1.3 取得経路:
 *  1. candidates come only from web_search events or the instruction input (never model self-reports)
 *  2. only the fetcher creates source cards (denylist + robots.txt + budget enforced before any GET)
 *  3. claims may cite only sources that have a source card
 *  5. URLs skipped for denylist / robots / budget are recorded as information gaps; the job goes on
 */

export type Tier = "T1" | "T2" | "T3" | "T4" | "T5";

/** Where a candidate URL came from. Anything else is not a candidate (§1.3-1). */
export type CandidateOrigin =
  | { kind: "search_event"; callId: string; itemId: string; query: string | null }
  | { kind: "instruction"; note: string };

export interface Candidate {
  url: string;
  origin: CandidateOrigin;
  /** Title shown in the search result (if any). */
  title?: string;
  /** Luna's reason for choosing it (free text, internal only). */
  why?: string;
  /** Tier suggested by Luna at selection time; used only when the domain is not in source_tiers.json. */
  tierSuggested?: Tier;
  /** Aspects / module ids this source is expected to cover (e.g. "bibliographic", "M01"). */
  aspects?: string[];
}

export type FetchDecisionKind =
  | "fetched" // GET done, card created
  | "denylisted" // matched harness/config/denylist.json → never requested
  | "robots_disallowed" // robots.txt forbids our UA (or robots unreachable with 5xx/network error)
  | "budget_exceeded" // job fetch budget exhausted → never requested
  | "duplicate" // same normalized URL (or same content hash) already fetched in this work
  | "private_address" // localhost / private IP (blocked unless the context allows it, i.e. tests)
  | "http_error" // non-2xx after redirects
  | "unsupported_type" // not text/html or text/plain (pdf, images, ...)
  | "too_large" // body over the size cap
  | "network_error"; // DNS / TLS / timeout

export interface FetchDecision {
  url: string;
  decision: FetchDecisionKind;
  /** HTTP status when a request was made. */
  status?: number;
  /** Final URL after redirects (each redirect hop is re-checked against denylist + robots). */
  finalUrl?: string;
  sourceId?: string;
  detail?: string;
  at: string; // ISO-8601 local
  origin: CandidateOrigin;
  /** Job that made this decision (CP-025). Absent in M1 records (derive from origin.callId prefix). */
  job_id?: string;
  /**
   * true when a page GET was actually issued for this candidate (redirect hops count once). This is the unit
   * of the fetch budget (§1.3 "取得60ページ"): BudgetState.fetchesUsed of a job == count of its get_issued
   * decisions. fetched / http_error / unsupported_type / too_large / content-hash duplicates are GETs;
   * denylisted / robots_disallowed / budget_exceeded / URL duplicates / private_address are not (CP-025).
   */
  get_issued?: boolean;
}

/** Source card (§1.3). Created by the fetcher only. Public projection later uses url/title/publisher/fetched_at/license. */
export interface SourceCard {
  /** "s" + first 10 hex of sha256(normalized URL). Stable across jobs → merge-friendly. */
  source_id: string;
  url: string;
  final_url: string;
  title: string;
  publisher: string;
  /** Hostname of final_url. */
  domain: string;
  /** Registrable domain (eTLD+1 approximation) — the "independence" key for confidence (§2.3). */
  site_key: string;
  tier: Tier;
  tier_basis: "table" | "model_suggested" | "default";
  /** e.g. "CC BY-SA 4.0" for Wikipedia; null when unknown. */
  license: string | null;
  fetched_at: string;
  /** "sha256:<hex>" of the extracted main text. */
  content_hash: string;
  /** Path (relative to the work dir) of the saved main text: research/raw/<source_id>.txt (git-ignored). */
  raw_text_path: string;
  text_chars: number;
  /**
   * Verification excerpts (§1.3): short spans of the source text that back claims. Total ≤ 400 chars
   * per source [暫定]. Filled after claim extraction (WP-1.3), never published.
   */
  excerpts: { text: string; offset: number; claim_ids: string[] }[];
  origin: CandidateOrigin;
}

/** Per-job budget (§1.3 [暫定]: search 40 / fetch 60 / wall 30 min). Identification (§4.6-3: 5 / 8) is counted in. */
export interface BudgetLimits {
  searches: number;
  fetches: number;
  wallMs: number;
}

export const DEFAULT_BUDGET: BudgetLimits = { searches: 40, fetches: 60, wallMs: 30 * 60_000 };
export const IDENTIFY_BUDGET: BudgetLimits = { searches: 5, fetches: 8, wallMs: 5 * 60_000 };

export interface BudgetState {
  limits: BudgetLimits;
  searchesUsed: number;
  fetchesUsed: number;
  startedAt: string;
}

/** Information gap recorded at research level (research/gaps.json). Never stops the job (§1.3-5, P-1). */
export interface ResearchGap {
  kind: "fetch_skipped" | "budget_exhausted" | "unverified_open_page" | "self_reported_url" | "no_sources_for_aspect";
  url?: string;
  aspect?: string;
  detail: string;
  at: string;
}

export interface FetchContext {
  /** Absolute path of works/<work_id>/ (or the staging dir during identification). */
  workDir: string;
  budget: BudgetState;
  /** Existing cards of this work (dedup by source_id / content_hash). */
  existing: SourceCard[];
  /** Tests only: allow 127.0.0.1 / private addresses. Production: false. */
  allowPrivateAddresses?: boolean;
  now?: () => Date;
  /** Job id stamped on every FetchDecision (CP-025). */
  jobId?: string;
}

export interface FetchBatchResult {
  cards: SourceCard[]; // newly created cards
  decisions: FetchDecision[]; // one per input candidate, same order
  gaps: ResearchGap[]; // one per skipped candidate (denylist / robots / budget / errors)
}

/** WP-1.2 fetcher. The only component that performs HTTP GETs of pages and creates source cards. */
export interface Fetcher {
  fetchAll(candidates: Candidate[], ctx: FetchContext): Promise<FetchBatchResult>;
}
