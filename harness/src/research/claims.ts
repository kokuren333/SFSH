import type { StageContext, StageResult } from "../job/context.ts";
import { claimIdFor, isClaimAspect, nextClaimNumber, type Claim, type ClaimDropReason, type Epistemic, type PhaseHint, type Spoiler } from "./claimTypes.ts";
import { buildClaimsPrompt, buildRephrasePrompt, CLAIM_TEXT_TARGET, CLAIMS_SCHEMA, EVIDENCE_QUOTE_MAX, MAX_CLAIMS_PER_SOURCE, REPHRASE_SCHEMA, type ClaimSourceInput } from "./prompts/claims.ts";
import { RESEARCH_FILES, readClaims, readRawText, readSources, writeClaims, writeSources } from "./researchIo.ts";
import { findQuote, hasVerbatimRun, normalizeForMatch, windows, type NormalizedText } from "./textMatch.ts";
import type { SourceCard } from "./types.ts";

/**
 * S1 claims (WP-1.3): Luna decomposes saved source text into own-words claims. Code verifies every
 * claim's evidence quote against raw/<sid>.txt, keeps only the position (never the quote), and drops
 * claims that copy ≥30 normalized chars of the source (C-2).
 */

/** [暫定] chars of each source passed to Luna. */
export const SOURCE_CHARS_PER_CALL = 12_000;
/** [暫定] approx. chars of source text per Luna call (sources are batched up to this). */
export const BATCH_CHARS = 24_000;
/** [暫定] total excerpt chars per source card. */
export const EXCERPT_TOTAL_MAX = 400;
/** Verbatim rule threshold (normalized chars). */
export const VERBATIM_RUN = 30;
export const CLAIMS_TIMEOUT_MS = 600_000;
/** Text stored for claims dropped as copied_phrase (the copied wording is never persisted). */
export const COPIED_TEXT_REDACTED = "（出典文の写しのため削除）";

export interface ExtractClaimsOptions {
  sourceIds?: string[];
  /** Ask Luna once to reword claims that fail the 30-char rule before dropping them (default true). */
  rephrase?: boolean;
  /** Work title for the prompt (defaults to ctx.workId). */
  workTitle?: string;
}

interface RawClaim {
  source_id: string;
  text: string;
  evidence_quote: string;
  aspects: string[];
  epistemic: Epistemic;
  phase_hint: PhaseHint;
  spoiler: Spoiler;
  entities: string[];
}

interface LoadedSource {
  card: SourceCard;
  raw: string;
  norm: NormalizedText;
  win?: Set<string>;
}

/** Sliding-window set of the source text (lazily built, cached on the loaded source). */
export function sourceWindows(src: { norm: NormalizedText; win?: Set<string> }): Set<string> {
  if (!src.win) src.win = windows(src.norm.norm, VERBATIM_RUN);
  return src.win;
}

/** Greedy batching by char count; a single source never exceeds SOURCE_CHARS_PER_CALL. */
export function batchByChars<T extends { text: string }>(items: T[], maxChars: number): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const it of items) {
    if (cur.length && size + it.text.length > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export async function extractClaims(ctx: StageContext, opts: ExtractClaimsOptions = {}): Promise<StageResult> {
  const warnings: string[] = [];
  const cards = readSources(ctx.workDir);
  const existing = readClaims(ctx.workDir);
  const workTitle = opts.workTitle ?? ctx.workId;

  let targets: SourceCard[];
  if (opts.sourceIds) {
    const want = new Set(opts.sourceIds);
    targets = cards.filter((c) => want.has(c.source_id));
    for (const id of want) if (!cards.some((c) => c.source_id === id)) warnings.push(`s1.claims: no source card for ${id}`);
  } else {
    const done = new Set<string>();
    for (const c of existing) {
      for (const s of c.source_ids) done.add(s);
      for (const e of c.evidence) done.add(e.source_id);
    }
    targets = cards.filter((c) => !done.has(c.source_id));
  }

  const loaded = new Map<string, LoadedSource>();
  const inputs: ClaimSourceInput[] = [];
  for (const card of targets) {
    const raw = readRawText(ctx.workDir, card);
    if (raw == null || !raw.trim()) {
      warnings.push(`s1.claims: raw text missing for ${card.source_id}`);
      continue;
    }
    loaded.set(card.source_id, { card, raw, norm: normalizeForMatch(raw) });
    inputs.push({
      source_id: card.source_id,
      title: card.title,
      tier: card.tier,
      domain: card.domain,
      text: raw.length > SOURCE_CHARS_PER_CALL ? raw.slice(0, SOURCE_CHARS_PER_CALL) : raw,
    });
  }

  const dropped: Record<string, number> = { no_source_card: 0, evidence_not_found: 0, copied_phrase: 0 };
  if (inputs.length === 0) {
    return { outputs: [], metrics: { sources: 0, batches: 0, extracted: 0, kept: 0, dropped: 0 }, warnings };
  }

  // 1. Luna extraction, batched.
  const batches = batchByChars(inputs, BATCH_CHARS);
  const rawClaims: RawClaim[] = [];
  for (const batch of batches) {
    const res = await ctx.luna.call({
      task: "s1.claims",
      prompt: buildClaimsPrompt(workTitle, batch),
      schema: CLAIMS_SCHEMA,
      tools: "none",
      jobId: ctx.jobId,
      timeoutMs: CLAIMS_TIMEOUT_MS,
    });
    const out = (res.output ?? { claims: [] }) as { claims: RawClaim[] };
    rawClaims.push(...(out.claims ?? []));
  }

  // 2. Deterministic checks.
  type Pending = { rc: RawClaim; claim: Omit<Claim, "claim_id">; copied: boolean };
  const pending: Pending[] = [];
  const perSource = new Map<string, number>();
  let overCap = 0;
  let overLength = 0;
  for (const rc of rawClaims) {
    const base: Omit<Claim, "claim_id"> = {
      text: (rc.text ?? "").trim(),
      source_ids: [],
      evidence: [],
      aspects: [...new Set((rc.aspects ?? []).filter(isClaimAspect))],
      epistemic: rc.epistemic,
      phase_hint: rc.phase_hint,
      spoiler: rc.spoiler,
      entities: rc.entities ?? [],
      authored_by: "luna",
      reviewed_by: null,
      review: "pending",
      status: "active",
      drop_reason: null,
    };
    const src = loaded.get(rc.source_id);
    if (!src) {
      pending.push({ rc, claim: drop(base, "no_source_card"), copied: false });
      continue;
    }
    const n = (perSource.get(rc.source_id) ?? 0) + 1;
    perSource.set(rc.source_id, n);
    if (n > MAX_CLAIMS_PER_SOURCE) {
      overCap++;
      continue;
    }
    if (base.text.length > CLAIM_TEXT_TARGET) overLength++;
    const quote = (rc.evidence_quote ?? "").trim();
    const hit = quote.length <= EVIDENCE_QUOTE_MAX * 2 ? findQuote(src.norm, quote) : null;
    base.source_ids = [rc.source_id];
    if (!hit) {
      pending.push({ rc, claim: drop(base, "evidence_not_found"), copied: false });
      continue;
    }
    base.evidence = [{ source_id: rc.source_id, offset: hit.offset, length: hit.length }];
    const copied = hasVerbatimRun(base.text, sourceWindows(src), VERBATIM_RUN);
    pending.push({ rc, claim: base, copied });
  }
  if (overCap) warnings.push(`s1.claims: ${overCap} claim(s) over ${MAX_CLAIMS_PER_SOURCE}/source ignored`);
  if (overLength) warnings.push(`s1.claims: ${overLength} claim(s) longer than ${CLAIM_TEXT_TARGET} chars (advisory)`);

  // 3. Optional one-shot rephrase of copied claims, then the 30-char rule decides.
  const copiedItems = pending.filter((p) => p.copied);
  if (copiedItems.length && opts.rephrase !== false) {
    try {
      const res = await ctx.luna.call({
        task: "s1.claims.rephrase",
        prompt: buildRephrasePrompt(copiedItems.map((p, i) => ({ key: String(i), text: p.claim.text }))),
        schema: REPHRASE_SCHEMA,
        tools: "none",
        jobId: ctx.jobId,
        timeoutMs: CLAIMS_TIMEOUT_MS,
      });
      const items = ((res.output ?? { items: [] }) as { items: { key: string; text: string }[] }).items ?? [];
      for (const it of items) {
        const p = copiedItems[Number(it.key)];
        if (!p || !it.text?.trim()) continue;
        const src = loaded.get(p.rc.source_id)!;
        if (!hasVerbatimRun(it.text, sourceWindows(src), VERBATIM_RUN)) {
          p.claim.text = it.text.trim();
          p.copied = false;
        }
      }
    } catch (e) {
      warnings.push(`s1.claims.rephrase failed: ${(e as Error).message}; copied claims dropped`);
    }
  }
  // The copied wording itself is not kept on disk (C-2); the dropped record stays for counting.
  for (const p of pending) if (p.copied) p.claim = { ...drop(p.claim, "copied_phrase"), text: COPIED_TEXT_REDACTED };

  // 4. Assign ids after the existing claims and persist.
  let n = nextClaimNumber(existing);
  const created: Claim[] = pending.map((p) => ({ claim_id: claimIdFor(n++), ...p.claim }));
  for (const c of created) if (c.drop_reason) dropped[c.drop_reason] = (dropped[c.drop_reason] ?? 0) + 1;
  writeClaims(ctx.workDir, [...existing, ...created]);

  // 5. Excerpts on the source cards (verification only, never published; ≤400 chars per source).
  const kept = created.filter((c) => c.status === "active");
  const latest = readSources(ctx.workDir);
  let excerptsChanged = false;
  for (const card of latest) {
    const src = loaded.get(card.source_id);
    if (!src) continue;
    const mine = kept.filter((c) => c.evidence.some((e) => e.source_id === card.source_id));
    if (!mine.length) continue;
    const excerpts = (card.excerpts ?? []).map((x) => ({ ...x, claim_ids: [...x.claim_ids] }));
    let total = excerpts.reduce((s, x) => s + x.text.length, 0);
    for (const c of mine) {
      for (const e of c.evidence) {
        if (e.source_id !== card.source_id) continue;
        const same = excerpts.find((x) => x.offset === e.offset && x.text.length === e.length);
        if (same) {
          if (!same.claim_ids.includes(c.claim_id)) same.claim_ids.push(c.claim_id);
          continue;
        }
        if (total + e.length > EXCERPT_TOTAL_MAX) continue;
        excerpts.push({ text: src.raw.slice(e.offset, e.offset + e.length), offset: e.offset, claim_ids: [c.claim_id] });
        total += e.length;
      }
    }
    card.excerpts = excerpts;
    excerptsChanged = true;
  }
  const outputs: string[] = [RESEARCH_FILES.claims];
  if (excerptsChanged) {
    writeSources(ctx.workDir, latest);
    outputs.push(RESEARCH_FILES.sources);
  }

  const droppedTotal = created.length - kept.length;
  ctx.log(`s1.claims: sources=${inputs.length} batches=${batches.length} extracted=${rawClaims.length} kept=${kept.length} dropped=${droppedTotal}`);
  return {
    outputs,
    metrics: {
      sources: inputs.length,
      batches: batches.length,
      extracted: rawClaims.length,
      kept: kept.length,
      dropped: droppedTotal,
      dropped_no_source_card: dropped.no_source_card,
      dropped_evidence_not_found: dropped.evidence_not_found,
      dropped_copied_phrase: dropped.copied_phrase,
    },
    warnings,
  };
}

function drop<T extends Omit<Claim, "claim_id">>(c: T, reason: Exclude<ClaimDropReason, null>): T {
  return { ...c, status: "dropped", drop_reason: reason };
}
