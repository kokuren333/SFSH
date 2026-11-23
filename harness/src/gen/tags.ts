/**
 * Tag suggestion (REQUIREMENTS §6.5 / §3.2): Luna proposes ≤ 8 tags from harness/config/tags.json using the
 * active claims (+ NKG work header); Haiku reviews (unsupported / spoiler / not_attribute), max 2 rounds.
 * Code drops anything outside the vocabulary and anything left unresolved, keeps ≤ 8 → gen/tags.json.
 * gen/tags.json records authored_by / reviewed_by (CP-029 weak point a); compose's authorship check covers it.
 */
import type { StageContext, StageResult } from "../job/context.ts";
import { claimIndex, readActiveClaims, readJson, readSourceCards, writeJson } from "../nkg/io.ts";
import { REVIEW_MAX_ROUNDS, completedResponses, runReviewLoop, type Finding, type FindingResponse, type RawFinding } from "../nkg/review.ts";
import type { Nkg } from "../nkg/types.ts";
import type { PortName } from "../model/types.ts";
import { GEN_FILES, MAX_TAGS, loadTagVocab, tagVocabVersion } from "./io.ts";
import { TAGS_SCHEMA, TAG_FINDINGS_SCHEMA, TAG_REVISION_SCHEMA, tagsPrompt, tagsReviewPrompt, tagsRevisePrompt } from "./prompts.ts";

export const S3_TIMEOUT_MS = 600_000;

interface TagProposal {
  slug: string;
  reason: string;
  claim_refs: string[];
}

export interface TagsFile {
  generated_at: string;
  /** Proposer (§6.5: Luna) — the port that made the s3.tags / s3.tags.revise calls. */
  authored_by: PortName;
  /** Reviewer (§6.5: Haiku) — the port that made the s3.tags.review calls. Must differ from authored_by (§3.2). */
  reviewed_by: PortName;
  vocab_version: number;
  max_rounds: number;
  proposals: TagProposal[];
  rounds: { round: number; findings: Finding[]; responses: FindingResponse[] }[];
  status: Record<string, string>;
  dropped: { slug: string; reason: "not_in_vocab" | "unresolved" | "over_limit" | "duplicate" }[];
  final: string[];
}

function normalize(list: unknown, claimIds: Set<string>): TagProposal[] {
  const out: TagProposal[] = [];
  for (const t of Array.isArray(list) ? list : []) {
    const slug = String((t as TagProposal)?.slug ?? "").trim();
    if (!slug) continue;
    out.push({
      slug,
      reason: String((t as TagProposal)?.reason ?? "").trim(),
      claim_refs: [...new Set(((t as TagProposal)?.claim_refs ?? []).map(String))].filter((c) => claimIds.has(c)),
    });
  }
  return out;
}

export async function suggestTags(ctx: StageContext): Promise<StageResult> {
  const vocab = loadTagVocab();
  const allowed = new Set(vocab.map((v) => v.slug));
  const claims = [...claimIndex(readActiveClaims(ctx.workDir), readSourceCards(ctx.workDir)).values()];
  const claimIds = new Set(claims.map((c) => c.claim_id));
  const nkg = readJson<Nkg | null>(ctx.workDir, "nkg/nkg.json", null);
  const work = readJson<{ title?: string; medium?: string; creators?: string[] } | null>(ctx.workDir, "work.json", null);
  const title = nkg?.work.title || work?.title || ctx.workId;
  const header = nkg
    ? [
        `- 題名: ${nkg.work.title}`,
        `- 媒体: ${nkg.work.medium}`,
        `- 作者・制作: ${nkg.work.creators.map((c) => c.name).join("、") || "不明"}`,
        `- ジャンル: ${nkg.work.genres.join(", ") || "なし"}`,
        `- 対象範囲: ${nkg.work.coverage.map((c) => c.label).join("・") || "全体"}`,
      ].join("\n")
    : `- 題名: ${title}\n- 媒体: ${work?.medium ?? "不明"}`;
  const warnings: string[] = [];
  let calls = 0;

  const first = await ctx.luna.call({
    task: "s3.tags",
    prompt: tagsPrompt({ title, header, vocab, claims }),
    schema: TAGS_SCHEMA,
    tools: "none",
    jobId: ctx.jobId,
    timeoutMs: S3_TIMEOUT_MS,
  });
  calls++;
  const proposals = normalize((first.output as { tags?: unknown }).tags, claimIds);

  const dropped: TagsFile["dropped"] = [];
  // vocabulary + duplicates are enforced before review (the reviewer only sees candidates that could survive)
  const initial: TagProposal[] = [];
  for (const p of proposals) {
    if (!allowed.has(p.slug)) dropped.push({ slug: p.slug, reason: "not_in_vocab" });
    else if (initial.some((x) => x.slug === p.slug)) dropped.push({ slug: p.slug, reason: "duplicate" });
    else initial.push(p);
  }

  const outcome = await runReviewLoop<TagProposal[]>({
    initial,
    maxRounds: REVIEW_MAX_ROUNDS,
    ids: (s) => s.map((t) => t.slug),
    review: async (state, round, prior) => {
      if (!state.length) return [];
      const r = await ctx.haiku.call({
        task: "s3.tags.review",
        prompt: tagsReviewPrompt({ title, tags: state, vocab, claims, prior, round, maxRounds: REVIEW_MAX_ROUNDS }),
        schema: TAG_FINDINGS_SCHEMA,
        jobId: ctx.jobId,
        timeoutMs: S3_TIMEOUT_MS,
      });
      calls++;
      // tag finding types are a tag-specific set; the loop treats `type` as opaque
      return ((r.output as { findings?: unknown[] }).findings ?? []) as unknown as RawFinding[];
    },
    revise: async (state, findings, round) => {
      const r = await ctx.luna.call({
        task: "s3.tags.revise",
        prompt: tagsRevisePrompt({ title, tags: state, findings, vocab, claims, round, maxRounds: REVIEW_MAX_ROUNDS }),
        schema: TAG_REVISION_SCHEMA,
        tools: "none",
        jobId: ctx.jobId,
        timeoutMs: S3_TIMEOUT_MS,
      });
      calls++;
      const out = r.output as { responses?: FindingResponse[]; tags?: unknown };
      const next: TagProposal[] = [];
      for (const p of normalize(out.tags, claimIds)) {
        if (!allowed.has(p.slug)) {
          if (!dropped.some((d) => d.slug === p.slug)) dropped.push({ slug: p.slug, reason: "not_in_vocab" });
        } else if (!next.some((x) => x.slug === p.slug)) next.push(p);
      }
      return { state: next, responses: out.responses ?? [] };
    },
  });

  const unresolved = new Set((outcome.unresolved ?? []).map((u) => u.target_id));
  for (const [id, st] of Object.entries(outcome.status)) if (st === "disputed") unresolved.add(id);
  const final: string[] = [];
  for (const t of outcome.state) {
    if (unresolved.has(t.slug)) dropped.push({ slug: t.slug, reason: "unresolved" });
    else if (final.length >= MAX_TAGS) dropped.push({ slug: t.slug, reason: "over_limit" });
    else final.push(t.slug);
  }

  const file: TagsFile = {
    generated_at: ctx.now().toISOString(),
    // the ports actually used above: proposals / revisions = ctx.luna, review = ctx.haiku
    authored_by: ctx.luna.port,
    reviewed_by: ctx.haiku.port,
    vocab_version: tagVocabVersion(),
    max_rounds: REVIEW_MAX_ROUNDS,
    proposals,
    rounds: outcome.rounds.map((r) => ({ round: r.round, findings: r.findings, responses: completedResponses(r) })),
    status: outcome.status,
    dropped,
    final,
  };
  const out = writeJson(ctx.workDir, GEN_FILES.tags, file);
  if (!final.length) warnings.push("tags: no tag survived (vocabulary / review)");
  ctx.log(`s3.tags: proposed=${proposals.length} final=${final.length} dropped=${dropped.length} findings=${outcome.counts.findings}`);
  return {
    outputs: [out],
    metrics: {
      calls,
      proposed: proposals.length,
      final: final.length,
      dropped_off_vocab: dropped.filter((d) => d.reason === "not_in_vocab").length,
      dropped_unresolved: dropped.filter((d) => d.reason === "unresolved").length,
      dropped_over_limit: dropped.filter((d) => d.reason === "over_limit").length,
      findings: outcome.counts.findings,
      rounds: outcome.counts.rounds,
    },
    warnings,
  };
}
