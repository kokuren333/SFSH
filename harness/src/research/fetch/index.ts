import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Candidate, FetchBatchResult, FetchContext, FetchDecision, FetchDecisionKind, Fetcher, SourceCard } from "../types.ts";
import { loadDenylist, isDenied, type DenylistConfig } from "./denylist.ts";
import { decodeBody, extractMainText } from "./extract.ts";
import { robotsForStatus, type RobotsPolicy } from "./robots.ts";
import { loadSourceTiers, resolveTier, siteKey, type SourceTierEntry } from "./tiers.ts";
import { hasPrivateAddress, httpUrl, localIso, normalizeUrl, sourceIdFor } from "./url.ts";

export { loadDenylist, isDenied } from "./denylist.ts";
export type { Denylist, DenylistConfig } from "./denylist.ts";
export { decodeBody, decodeEntities, extractMainText } from "./extract.ts";
export { parseRobots, robotsForStatus, PRODUCT_TOKEN } from "./robots.ts";
export { loadSourceTiers, resolveTier, siteKey } from "./tiers.ts";
export type { SourceTierEntry } from "./tiers.ts";
export { normalizeUrl, sourceIdFor, isPrivateIp } from "./url.ts";

export const USER_AGENT = "SFSH-research/0.1 (+private non-commercial research harness)";
const PAGE_CAP = 3 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface FetcherOptions {
  denylist?: DenylistConfig;
  sourceTiers?: SourceTierEntry[];
  /** Defaults to 20 seconds; also covers reading the response body. */
  timeoutMs?: number;
  /** Observation hook (tests): called right before each HTTP request is sent, with the client-side send time
   *  (the same Date.now() value the politeness interval is computed from). */
  onRequest?: (url: string, sentAtMs: number) => void;
}

class Skipped extends Error {
  readonly kind: FetchDecisionKind;
  readonly status?: number;
  constructor(kind: FetchDecisionKind, detail: string, status?: number) {
    super(detail);
    this.kind = kind;
    this.status = status;
  }
}

async function readBody(response: Response, cap: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > cap) {
    await response.body?.cancel();
    throw new Skipped("too_large", `Body exceeds ${cap} bytes`, response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > cap) {
        await reader.cancel();
        throw new Skipped("too_large", `Body exceeds ${cap} bytes`, response.status);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createFetcher(opts: FetcherOptions = {}): Fetcher {
  const denylist = loadDenylist(opts.denylist);
  const tiers = loadSourceTiers(opts.sourceTiers);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  const robotsCache = new Map<string, Promise<RobotsPolicy>>();
  const lastRequest = new Map<string, number>();
  // Serialize batches, including concurrent callers, for budget/politeness determinism.
  let queue = Promise.resolve();

  async function polite(url: URL): Promise<void> {
    const last = lastRequest.get(url.hostname);
    if (last === undefined) return;
    // Loop: a timer may fire slightly before Date.now() has advanced by the full interval (clock granularity).
    for (let wait = 1000 - (Date.now() - last); wait > 0; wait = 1000 - (Date.now() - last)) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  async function guard(url: URL, ctx: FetchContext): Promise<void> {
    if (!ctx.allowPrivateAddresses && await hasPrivateAddress(url)) throw new Skipped("private_address", "Hostname resolves to a private or loopback address");
    const denied = isDenied(url.href, denylist);
    if (denied.denied) throw new Skipped("denylisted", denied.reason!);
  }

  function checkBudget(ctx: FetchContext, firstGet: boolean): void {
    if ((firstGet && ctx.budget.fetchesUsed >= ctx.budget.limits.fetches)
      || (ctx.now?.() ?? new Date()).getTime() - Date.parse(ctx.budget.startedAt) >= ctx.budget.limits.wallMs) {
      throw new Skipped("budget_exceeded", "Page count or wall-clock budget exhausted");
    }
  }

  async function request<T>(url: URL, consume: (response: Response) => Promise<T>, beforeGet?: () => void): Promise<T> {
    await polite(url);
    beforeGet?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      const sentAt = Date.now();
      lastRequest.set(url.hostname, sentAt);
      opts.onRequest?.(url.href, sentAt);
      const response = await fetch(url, {
        redirect: "manual", signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9" },
      });
      return await consume(response);
    } finally { clearTimeout(timer); }
  }

  async function robots(url: URL, ctx: FetchContext): Promise<RobotsPolicy> {
    let cached = robotsCache.get(url.origin);
    if (!cached) {
      cached = (async () => {
        let target = new URL("/robots.txt", url.origin);
        try {
          // RFC 9309 §2.3.1.2: follow up to five redirects, including across origins.
          for (let hop = 0; hop <= 5; hop++) {
            await guard(target, ctx);
            const result = await request(target, async (response) => {
              if (REDIRECTS.has(response.status)) {
                const location = response.headers.get("location");
                await response.body?.cancel();
                return { location, status: response.status, text: "" };
              }
              if (!response.ok) {
                await response.body?.cancel();
                return { location: null, status: response.status, text: "" };
              }
              return { location: null, status: response.status, text: new TextDecoder().decode(await readBody(response, 512 * 1024)) };
            });
            if (!REDIRECTS.has(result.status)) return robotsForStatus(result.status, result.text);
            if (!result.location) return robotsForStatus(503);
            target = httpUrl(new URL(result.location, target).href);
          }
        } catch { /* §1.3-2: robots network/timeout/unsafe redirects fail closed. */ }
        return robotsForStatus(503);
      })();
      robotsCache.set(url.origin, cached);
    }
    return cached;
  }

  async function run(candidates: Candidate[], ctx: FetchContext): Promise<FetchBatchResult> {
    if (!isAbsolute(ctx.workDir) || !Number.isFinite(Date.parse(ctx.budget.startedAt))
      || !Number.isFinite(ctx.budget.fetchesUsed) || ctx.budget.fetchesUsed < 0
      || !Number.isFinite(ctx.budget.limits.fetches) || ctx.budget.limits.fetches < 0
      || !Number.isFinite(ctx.budget.limits.wallMs) || ctx.budget.limits.wallMs < 0) {
      throw new TypeError("Invalid FetchContext: absolute workDir and finite nonnegative budget values required");
    }
    const result: FetchBatchResult = { cards: [], decisions: [], gaps: [] };
    const seen = new Set(ctx.existing.map((card) => card.source_id));
    const hashes = new Set(ctx.existing.map((card) => card.content_hash));
    for (const candidate of candidates) {
      const decision: FetchDecision = { url: candidate.url, origin: candidate.origin, decision: "network_error", at: localIso(ctx.now?.() ?? new Date()) };
      let target: URL | undefined;
      let attempted = false;
      try {
        target = httpUrl(normalizeUrl(httpUrl(candidate.url).href));
        const normalized = target.href;
        const sid = sourceIdFor(normalized);
        decision.sourceId = sid;
        if (seen.has(sid)) throw new Skipped("duplicate", "Normalized URL already exists in this work or batch");
        seen.add(sid);
        for (let hop = 0; hop <= 5; hop++) {
          decision.finalUrl = target.href;
          // §1.3-2: this order applies before the first GET and every redirect hop.
          await guard(target, ctx);
          checkBudget(ctx, !attempted);
          if (!(await robots(target, ctx)).allowed(target.href)) throw new Skipped("robots_disallowed", "robots.txt disallows this URL or could not be safely retrieved");
          const response = await request(target, async (response) => {
            decision.status = response.status;
            if (REDIRECTS.has(response.status)) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              if (!location) throw new Skipped("http_error", "Redirect has no Location header", response.status);
              return { redirect: location, bytes: null, contentType: "" };
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw new Skipped("http_error", `HTTP ${response.status}`, response.status);
            }
            const contentType = response.headers.get("content-type") ?? "";
            const mime = contentType.split(";", 1)[0].trim().toLowerCase();
            if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mime)) {
              await response.body?.cancel();
              throw new Skipped("unsupported_type", `Unsupported Content-Type: ${contentType || "(missing)"}`, response.status);
            }
            return { redirect: null, bytes: await readBody(response, PAGE_CAP), contentType };
          }, () => {
            // Check again after robots and politeness waits, immediately before GET.
            checkBudget(ctx, !attempted);
            if (!attempted) { ctx.budget.fetchesUsed++; attempted = true; }
          });
          if (response.redirect !== null) {
            if (hop === 5) throw new Skipped("http_error", "More than 5 redirects", decision.status);
            target = httpUrl(normalizeUrl(new URL(response.redirect, target).href));
            continue;
          }
          const html = decodeBody(response.bytes!, response.contentType);
          const extracted = response.contentType.split(";", 1)[0].trim().toLowerCase() === "text/plain"
            ? { title: candidate.title ?? target.hostname, publisher: target.hostname, text: html.trim().slice(0, 60_000) }
            : extractMainText(html, target.href);
          const contentHash = "sha256:" + createHash("sha256").update(extracted.text).digest("hex");
          if (hashes.has(contentHash)) throw new Skipped("duplicate", "Extracted content hash already exists in this work or batch");
          const rawTextPath = `research/raw/${sid}.txt`;
          const card: SourceCard = {
            source_id: sid, url: normalized, final_url: target.href, title: extracted.title || candidate.title || target.href,
            publisher: extracted.publisher, domain: target.hostname, site_key: siteKey(target.hostname),
            ...resolveTier(target.href, candidate, tiers), fetched_at: localIso(ctx.now?.() ?? new Date()),
            content_hash: contentHash, raw_text_path: rawTextPath, text_chars: extracted.text.length, excerpts: [], origin: candidate.origin,
          };
          const htmlPath = join(ctx.workDir, "research", "raw", `${sid}.html`);
          const textPath = join(ctx.workDir, rawTextPath);
          await mkdir(join(ctx.workDir, "research", "raw"), { recursive: true });
          try {
            await writeFile(htmlPath, html, "utf8");
            await writeFile(textPath, extracted.text, "utf8");
          } catch (error) {
            await Promise.allSettled([unlink(htmlPath), unlink(textPath)]);
            throw error;
          }
          hashes.add(contentHash);
          result.cards.push(card);
          decision.decision = "fetched";
          break;
        }
      } catch (error) {
        decision.decision = error instanceof Skipped ? error.kind : "network_error";
        decision.detail = error instanceof Error ? error.message : String(error);
        if (error instanceof Skipped && error.status !== undefined) decision.status = error.status;
      }
      decision.get_issued = attempted;
      if (ctx.jobId) decision.job_id = ctx.jobId;
      result.decisions.push(decision);
      // §1.3-5 / P-1: every skipped URL is a gap, never a job-level exception.
      if (decision.decision !== "fetched" && decision.decision !== "duplicate") {
        result.gaps.push({ kind: decision.decision === "budget_exceeded" ? "budget_exhausted" : "fetch_skipped",
          url: candidate.url, detail: `${decision.decision}: ${decision.detail ?? "URL skipped"}`, at: decision.at });
      }
    }
    return result;
  }

  return {
    fetchAll(candidates, ctx) {
      const pending = queue.then(() => run(candidates, ctx));
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
}
