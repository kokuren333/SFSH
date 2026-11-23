import { isoLocal } from "../model/callLog.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { COPIED_TEXT_REDACTED, VERBATIM_RUN, sourceWindows } from "./claims.ts";
import type { Claim, ClaimAction, ClaimFinding, ClaimReviewEntry, MissingAspect } from "./claimTypes.ts";
import { buildReviewPrompt, buildRevisePrompt, REVIEW_SCHEMA, REVISE_SCHEMA, type ReviewItem, type ReviseItem } from "./prompts/claimReview.ts";
import { appendClaimsReview, RESEARCH_FILES, readClaims, readRawText, readSources, writeClaims } from "./researchIo.ts";
import { hasVerbatimRun, normalizeForMatch, type NormalizedText } from "./textMatch.ts";
import { REVIEW_MAX_ROUNDS } from "../nkg/review.ts";
import { summarizeReviews } from "../nkg/reviewSummary.ts";

/**
 * S1 claim review (WP-1.3 / WP-2.1, REQUIREMENTS §3.2–3.3): Haiku points out problems (findings only), Luna
 * answers each targeted claim once per round (revise | drop | keep), code applies the answers.
 * Same semantics as nkg/review.ts runReviewLoop, with claim-specific details:
 *  - up to REVIEW_MAX_ROUNDS (2) rounds; round 2 re-reviews only the claims that had findings in round 1 and
 *    are still active (with the round-1 findings and answers appended to the prompt); stops early when empty.
 *  - an answer resolves the claim's findings of that round when it is an effective revise (text and/or
 *    epistemic) or a drop. keep / empty revise / no answer = declined → the claim stays unresolved until a
 *    later round re-raises and resolves it. A round with no findings for it does not resolve it.
 *  - when the claim is final (no further round): unresolved with copied_phrase → dropped, drop_reason
 *    copied_phrase, text redacted (C-2); other unresolved → review "disputed" and the findings go to the
 *    entry's `advisory`. A revised text that copies the source is dropped as copied_phrase (unchanged from M1).
 */

export const REVIEW_BATCH = 120;
export const CONTEXT_PAD = 150;
export const REVIEW_TIMEOUT_MS = 600_000;

export interface ReviewClaimsOptions {
  maxRounds?: number;
  claimIds?: string[];
  workTitle?: string;
}

/** WP-2.1 additions to a claims_review.json entry (the base type lives in claimTypes.ts). */
export interface ClaimAdvisory {
  target_id: string;
  type: string;
  severity: string;
  evidence: string;
  round: number;
}
export type ClaimReviewEntryV2 = ClaimReviewEntry & {
  /** Unresolved non-deleting findings of claims that became final in this entry (→ S4 advisory). */
  advisory: ClaimAdvisory[];
  /** Claims dropped as copied_phrase in this entry (C-2). */
  deleted: string[];
};

interface RoundHistory {
  round: number;
  findings: ClaimFinding[];
  action: ClaimAction | null;
}

function priorClaimBlock(items: { claim_id: string; history: RoundHistory[] }[], round: number, maxRounds: number): string {
  const rows = items.filter((i) => i.history.some((h) => h.findings.length));
  if (!rows.length) return "";
  const lines = [
    "",
    `## 前回までの指摘と作成側の対応（今回は第${round}回レビュー${round >= maxRounds ? "で、これが最後" : ""}）`,
    "- 上の claim は作成側の対応後の状態です。改めて出典本文の周辺と突き合わせてください。",
    "- まだ問題が残っているもの（前回 keep されたものを含む）は、もう一度指摘してください。作成側がもう一度直す機会になります。指摘しなかった keep の指摘は未解決のまま残ります。",
    "- 解消した問題は指摘しないでください。最後のレビューのあとも未解決の claim は disputed になり、copied_phrase が未解決の claim は削除されます。",
  ];
  for (const it of rows) {
    for (const h of it.history) {
      for (const f of h.findings) {
        const a = h.action;
        lines.push(`- ${it.claim_id} 第${h.round}回 [${f.type}] ${f.evidence} → ${a ? `${a.action}（${a.reason}）` : "回答なし"}`);
      }
    }
  }
  return lines.join("\n");
}

function lastRoundClaimNote(round: number, maxRounds: number): string {
  return round < maxRounds
    ? `\n\n## 往復\n- これは第${round}回の対応です（最大${maxRounds}往復）。対応後にもう一度レビューがあります。`
    : `\n\n## 往復\n- これは第${round}回で最後の対応です。keep した指摘は未解決として disputed になり、copied_phrase の指摘を keep した claim は削除されます。`;
}

export async function reviewClaims(ctx: StageContext, opts: ReviewClaimsOptions = {}): Promise<StageResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? REVIEW_MAX_ROUNDS);
  const workTitle = opts.workTitle ?? ctx.workId;
  const warnings: string[] = [];
  const claims = readClaims(ctx.workDir);
  const byId = new Map(claims.map((c) => [c.claim_id, c]));
  const cards = new Map(readSources(ctx.workDir).map((c) => [c.source_id, c]));
  const want = opts.claimIds ? new Set(opts.claimIds) : null;

  const rawCache = new Map<string, { raw: string; norm: NormalizedText; win?: Set<string> } | null>();
  const loadRaw = (sid: string) => {
    if (!rawCache.has(sid)) {
      const card = cards.get(sid);
      const raw = card ? readRawText(ctx.workDir, card) : null;
      rawCache.set(sid, raw == null ? null : { raw, norm: normalizeForMatch(raw) });
    }
    return rawCache.get(sid)!;
  };
  /** Evidence span ±150 chars, read from raw text now; never stored. */
  const contextFor = (c: Claim): { sid: string; text: string } => {
    for (const e of c.evidence) {
      const r = loadRaw(e.source_id);
      if (!r) continue;
      const from = Math.max(0, e.offset - CONTEXT_PAD);
      const to = Math.min(r.raw.length, e.offset + e.length + CONTEXT_PAD);
      return { sid: e.source_id, text: r.raw.slice(from, to).replace(/\s+/g, " ") };
    }
    return { sid: c.source_ids[0] ?? "", text: "（出典本文を読めない）" };
  };
  const copiesAnySource = (c: Claim, text: string): boolean =>
    [...new Set([...c.source_ids, ...c.evidence.map((e) => e.source_id)])].some((sid) => {
      const r = loadRaw(sid);
      return !!r && hasVerbatimRun(text, sourceWindows(r), VERBATIM_RUN);
    });

  let targets = claims.filter((c) => c.status === "active" && c.review === "pending" && (!want || want.has(c.claim_id)));
  const stats = { reviewed: 0, findings: 0, agreed: 0, revised: 0, disputed: 0, dropped: 0, haiku_calls: 0, luna_calls: 0 };
  const byType: Record<string, number> = {};
  const allMissing: MissingAspect[] = [];
  const touched = new Set<string>();
  const history = new Map<string, RoundHistory[]>();
  /** Findings of the last round that targeted a claim and were not resolved by its answer. */
  const open = new Map<string, { round: number; findings: ClaimFinding[]; prevReview: Claim["review"] }>();
  let deletedTotal = 0;
  let advisoryTotal = 0;
  let rounds = 0;

  for (let round = 1; round <= maxRounds && targets.length; round++) {
    rounds = round;
    const last = round === maxRounds;
    const next: Claim[] = [];
    for (let b = 0; b * REVIEW_BATCH < targets.length; b++) {
      const batch = targets.slice(b * REVIEW_BATCH, (b + 1) * REVIEW_BATCH);
      const batchIds = new Set(batch.map((c) => c.claim_id));
      const ctxById = new Map(batch.map((c) => [c.claim_id, contextFor(c)]));
      const covered: Record<string, number> = {};
      for (const c of byId.values()) if (c.status === "active") for (const a of c.aspects) covered[a] = (covered[a] ?? 0) + 1;

      const items: ReviewItem[] = batch.map((c) => ({
        claim_id: c.claim_id,
        text: c.text,
        aspects: c.aspects,
        epistemic: c.epistemic,
        source_id: ctxById.get(c.claim_id)!.sid,
        context: ctxById.get(c.claim_id)!.text,
      }));
      const hres = await ctx.haiku.call({
        task: "s1.claims.review",
        prompt:
          buildReviewPrompt(workTitle, items, covered) +
          priorClaimBlock(
            batch.map((c) => ({ claim_id: c.claim_id, history: history.get(c.claim_id) ?? [] })),
            round,
            maxRounds,
          ),
        schema: REVIEW_SCHEMA,
        jobId: ctx.jobId,
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      stats.haiku_calls++;
      const findings = (((hres.output ?? {}) as { findings?: ClaimFinding[] }).findings ?? []).filter(Boolean);
      stats.findings += findings.length;

      const grouped = new Map<string, ClaimFinding[]>();
      const missing: MissingAspect[] = [];
      for (const f of findings) {
        byType[f.type] = (byType[f.type] ?? 0) + 1;
        if (f.type === "missing") {
          missing.push({ aspect: f.missing_aspect ?? null, suggested_query: f.suggested_query ?? null, note: f.evidence });
          continue;
        }
        if (!f.target_id || !batchIds.has(f.target_id)) {
          warnings.push(`s1.claims.review: finding ${f.type} with unknown target ${f.target_id ?? "null"} ignored`);
          continue;
        }
        const arr = grouped.get(f.target_id) ?? [];
        arr.push(f);
        grouped.set(f.target_id, arr);
      }
      allMissing.push(...missing);

      let actions: ClaimAction[] = [];
      if (grouped.size) {
        const reviseItems: ReviseItem[] = [...grouped.entries()].map(([id, fs]) => {
          const c = byId.get(id)!;
          return {
            claim_id: id,
            text: c.text,
            epistemic: c.epistemic,
            context: ctxById.get(id)!.text,
            findings: fs.map((f) => ({ type: f.type, severity: f.severity, evidence: f.evidence })),
          };
        });
        const lres = await ctx.luna.call({
          task: "s1.claims.revise",
          prompt: buildRevisePrompt(workTitle, reviseItems) + lastRoundClaimNote(round, maxRounds),
          schema: REVISE_SCHEMA,
          tools: "none",
          jobId: ctx.jobId,
          timeoutMs: REVIEW_TIMEOUT_MS,
        });
        stats.luna_calls++;
        actions = (((lres.output ?? {}) as { actions?: ClaimAction[] }).actions ?? []).filter((a) => a && grouped.has(a.claim_id));
      }

      const outcomes: ClaimReviewEntry["outcomes"] = [];
      const advisory: ClaimAdvisory[] = [];
      const deleted: string[] = [];
      for (const c of batch) {
        const fs = grouped.get(c.claim_id) ?? [];
        c.reviewed_by = "haiku";
        touched.add(c.claim_id);
        let act: ClaimAction | null = null;
        let again = false;
        if (fs.length === 0) {
          // no finding this round; a claim left unresolved by an earlier round stays unresolved
          if (c.review === "pending") c.review = "agreed";
        } else {
          act = actions.find((a) => a.claim_id === c.claim_id) ?? { claim_id: c.claim_id, action: "keep", text: null, epistemic: null, reason: "no answer" };
          const prevReview = open.get(c.claim_id)?.prevReview ?? c.review;
          open.delete(c.claim_id);
          const newText = act.text?.trim() || null;
          if (act.action === "drop") {
            c.status = "dropped";
            c.drop_reason = "review_unsupported";
          } else if (act.action === "revise" && (newText || act.epistemic)) {
            if (newText && copiesAnySource(c, newText)) {
              c.status = "dropped";
              c.drop_reason = "copied_phrase";
              deleted.push(c.claim_id);
            } else {
              if (newText) c.text = newText;
              if (act.epistemic) c.epistemic = act.epistemic;
              c.review = "revised";
            }
          } else {
            // keep / empty revise / no answer = declined → unresolved (provisionally disputed)
            open.set(c.claim_id, { round, findings: fs, prevReview });
            c.review = "disputed";
          }
          if (c.status === "active" && !last) {
            next.push(c);
            again = true;
          }
        }
        history.set(c.claim_id, [...(history.get(c.claim_id) ?? []), { round, findings: fs, action: act }]);
        const o = open.get(c.claim_id);
        if (!again && c.status === "active" && o) {
          // final for this claim: apply the unresolved findings
          if (o.findings.some((f) => f.type === "copied_phrase")) {
            c.status = "dropped"; // unresolved copied_phrase is removed (C-2, §3.3-2)
            c.drop_reason = "copied_phrase";
            c.text = COPIED_TEXT_REDACTED;
            c.review = o.prevReview; // a dropped claim keeps the review state it had before (M1 behaviour)
            deleted.push(c.claim_id);
          } else {
            c.review = "disputed";
            for (const f of o.findings) advisory.push({ target_id: c.claim_id, type: f.type, severity: f.severity, evidence: f.evidence, round: o.round });
          }
          open.delete(c.claim_id);
        }
        stats.reviewed++;
        outcomes.push({ claim_id: c.claim_id, review: c.review, status: c.status, drop_reason: c.drop_reason });
      }
      deletedTotal += deleted.length;
      advisoryTotal += advisory.length;

      writeClaims(ctx.workDir, claims);
      const entry: ClaimReviewEntryV2 = { round, batch: b + 1, at: isoLocal(ctx.now()), claim_ids: batch.map((c) => c.claim_id), findings, actions, outcomes, missing, advisory, deleted };
      appendClaimsReview(ctx.workDir, [entry]);
    }
    targets = next;
  }

  for (const id of touched) {
    const c = byId.get(id)!;
    if (c.status === "dropped") stats.dropped++;
    else if (c.review === "agreed") stats.agreed++;
    else if (c.review === "revised") stats.revised++;
    else if (c.review === "disputed") stats.disputed++;
  }
  for (const m of allMissing) warnings.push(`missing aspect: ${m.aspect ?? "?"}${m.suggested_query ? ` (query: ${m.suggested_query})` : ""}`);
  ctx.log(`s1.claims.review: rounds=${rounds} reviewed=${stats.reviewed} findings=${stats.findings} dropped=${stats.dropped} missing=${allMissing.length}`);

  const metrics: Record<string, number | string> = { rounds, ...stats, missing: allMissing.length, deleted_copied_phrase: deletedTotal, advisory: advisoryTotal };
  for (const [k, v] of Object.entries(byType)) metrics[`finding_${k}`] = v;
  if (allMissing.length) {
    metrics.missing_aspects = [...new Set(allMissing.map((m) => m.aspect ?? "?"))].join(",");
  }
  const outputs: string[] = rounds ? [RESEARCH_FILES.claims, RESEARCH_FILES.claimsReview] : [];
  if (rounds) {
    // quality metrics (§3.3-4) → nkg/review_summary.json + work.json review_stats; never stops the job (P-1)
    try {
      outputs.push(summarizeReviews(ctx.workDir, ctx.now()).output);
    } catch (e) {
      warnings.push(`review summary not written: ${(e as Error).message}`);
    }
  }
  return { outputs, metrics, warnings };
}
