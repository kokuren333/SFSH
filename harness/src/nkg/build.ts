/**
 * S2 stages (WP-1.5): buildPhases → buildFactLayer → buildInterpLayer → assembleNkg.
 * Each stage is (ctx: StageContext) => Promise<StageResult>, reads only earlier files and overwrites its own output.
 *
 *  - fact layer: Luna authors (events first, then people, then world) → Haiku reviews → Luna revises (≤ REVIEW_MAX_ROUNDS = 2 rounds)
 *  - interp layer: Haiku authors (reverse plot, motives/arcs, themes/emotion, extras) → Luna reviews → Haiku revises (≤ 2 rounds)
 *  - after the loop (WP-2.1): unresolved copied_phrase → element deleted (C-2); other unresolved → advisory;
 *    zeroed element types / structural zeros → stage warnings (never stop the job, P-1)
 *  - assemble: code maps claim_refs → provenance, rejects basis-less elements, computes confidence, gaps, validation
 */
import type { StageContext, StageResult } from "../job/context.ts";
import type { ModelPort } from "../model/types.ts";
import type { Claim } from "../research/claimTypes.ts";
import type { SourceCard } from "../research/types.ts";
import {
  FACT_GROUPS,
  FACT_MODULES,
  INTERP_GROUPS,
  INTERP_MODULES,
  SPECS,
  draftsFromOutput,
  draftsToOutput,
  enabledSpecs,
  groupSchema,
  normalizeIds,
  type CallGroup,
  type Draft,
  type ElementSpec,
} from "./elements.ts";
import { finalizeLayers, type FinalizeContext, type LayerInput, type Rejection } from "./finalize.ts";
import { NKG_FILES, claimIndex, readActiveClaims, readJson, readSourceCards, toNkgSource, writeJson } from "./io.ts";
import { readModuleSelection, readWorkTitle, type ModuleSelectionFile } from "./modules.ts";
import {
  PHASES_SCHEMA,
  authoringPrompt,
  layerReviewPrompt,
  phasesPrompt,
  phasesReviewPrompt,
  revisionPrompt,
  type PhasesOutput,
} from "./prompts/layers.ts";
import {
  FINDINGS_SCHEMA,
  REVIEW_MAX_ROUNDS,
  RESPONSES_SCHEMA,
  advisoryFrom,
  completedResponses,
  copiedPhraseTargets,
  lastRoundNote,
  priorRoundsBlock,
  runReviewLoop,
  type AdvisoryEntry,
  type Finding,
  type FindingResponse,
  type RawFinding,
  type ReviewRound,
  type UnresolvedEntry,
} from "./review.ts";
import { summarizeReviews } from "./reviewSummary.ts";
import type { Gap, ModelName, ModuleId, Nkg, NkgWork, Phase, ReviewState } from "./types.ts";
import { writeValidation } from "./validate.ts";

export const AUTHORING_TIMEOUT_MS = 600_000;
/** AMENDMENT 12: authoring waves (groups of one wave run in parallel and see the drafts of the earlier waves). */
export const FACT_WAVES: string[][] = [["events"], ["people", "world"]];
export const INTERP_WAVES: string[][] = [["reverse_plot", "motives_arcs", "themes_emotion"], ["extras"]];

export interface PhasesFile {
  generated_at: string;
  phases: (Phase & { scope: string; claim_refs: string[] })[];
  proposed_count: number;
  fallback: boolean;
  review: { reviewer: ModelName; findings: RawFinding[] };
  warnings: string[];
}

export interface LayerFile {
  layer: "fact" | "interp";
  author: ModelName;
  reviewer: ModelName;
  generated_at: string;
  groups: { name: string; kinds: string[]; called: boolean; elements: number }[];
  drafts: Draft[];
  status: Record<string, ReviewState>;
  id_renames: { id: string; from: string }[];
}

// ------------------------------------------------------------------ shared inputs
interface S2Inputs {
  title: string;
  coverageLabel: string;
  claims: Claim[];
  claimsById: Map<string, Claim>;
  cards: SourceCard[];
  ms: ModuleSelectionFile;
  enabled: Set<string>;
}

function loadInputs(ctx: StageContext): S2Inputs {
  const ms = readModuleSelection(ctx.workDir);
  if (!ms) throw new Error(`S2: ${NKG_FILES.moduleSelection} missing — run selectModules first`);
  const cards = readSourceCards(ctx.workDir);
  const claimsById = claimIndex(readActiveClaims(ctx.workDir), cards);
  return {
    title: readWorkTitle(ctx.workDir, ctx.workId),
    coverageLabel: ctx.range.map((r) => r.label).filter(Boolean).join("・") || "全体",
    claims: [...claimsById.values()],
    claimsById,
    cards,
    ms,
    enabled: new Set(ms.module_selection.filter((m) => m.enabled).map((m) => m.module)),
  };
}

function readPhases(ctx: StageContext): PhasesFile {
  const p = readJson<PhasesFile | null>(ctx.workDir, NKG_FILES.phases, null);
  if (!p) throw new Error(`S2: ${NKG_FILES.phases} missing — run buildPhases first`);
  return p;
}

const DEFAULT_PHASE_LABELS = ["序盤", "中盤", "結末"];

// ------------------------------------------------------------------ phases
export async function buildPhases(ctx: StageContext): Promise<StageResult> {
  const inp = loadInputs(ctx);
  const warnings: string[] = [];
  const preferMore = inp.ms.expansion?.hints?.prefer_more_phases === true;
  const res = await ctx.luna.call({
    task: "s2.phases",
    prompt: phasesPrompt({ title: inp.title, claims: inp.claims, preferMore, coverage: inp.coverageLabel }),
    schema: PHASES_SCHEMA,
    tools: "none",
    jobId: ctx.jobId,
    timeoutMs: AUTHORING_TIMEOUT_MS,
  });
  const proposed = [...((res.output as PhasesOutput).phases ?? [])].filter((p) => p.label?.trim()).sort((a, b) => a.order - b.order);
  let chosen = proposed.map((p) => ({ label: p.label.trim(), scope: p.scope ?? "", claim_refs: (p.claim_refs ?? []).filter((c) => inp.claimsById.has(c)) }));
  let fallback = false;
  if (chosen.length < 3) {
    warnings.push(`phases: Luna proposed ${chosen.length} (<3) → default 序盤/中盤/結末`);
    chosen = DEFAULT_PHASE_LABELS.map((label) => ({ label, scope: "", claim_refs: [] }));
    fallback = true;
  } else if (chosen.length > 7) {
    warnings.push(`phases: Luna proposed ${chosen.length} (>7) → kept first 6 + last`);
    chosen = [...chosen.slice(0, 6), chosen[chosen.length - 1]];
  }
  const phases = chosen.map((p, i) => ({ id: `ph${i + 1}`, label: p.label, order: i + 1, scope: p.scope, claim_refs: p.claim_refs }));

  const rv = await ctx.haiku.call({
    task: "s2.phases.review",
    prompt: phasesReviewPrompt({ title: inp.title, phases, claims: inp.claims }),
    schema: FINDINGS_SCHEMA,
    jobId: ctx.jobId,
    timeoutMs: AUTHORING_TIMEOUT_MS,
  });
  const findings = ((rv.output as { findings?: RawFinding[] }).findings ?? []) as RawFinding[];
  const file: PhasesFile = {
    generated_at: ctx.now().toISOString(),
    phases,
    proposed_count: proposed.length,
    fallback,
    review: { reviewer: "haiku", findings },
    warnings,
  };
  const out = writeJson(ctx.workDir, NKG_FILES.phases, file);
  ctx.log(`s2.phases: ${phases.map((p) => p.label).join(" / ")} (findings ${findings.length})`);
  return { outputs: [out], metrics: { phases: phases.length, phase_findings: findings.length, phase_fallback: fallback ? 1 : 0 }, warnings };
}

// ------------------------------------------------------------------ layers
interface LayerConfig {
  layer: "fact" | "interp";
  author: ModelName;
  groups: CallGroup[];
  modules: ModuleId[];
}

const FACT: LayerConfig = { layer: "fact", author: "luna", groups: FACT_GROUPS, modules: FACT_MODULES };
const INTERP: LayerConfig = { layer: "interp", author: "haiku", groups: INTERP_GROUPS, modules: INTERP_MODULES };

const port = (ctx: StageContext, m: ModelName): ModelPort => (m === "luna" ? ctx.luna : ctx.haiku);
const opposite = (m: ModelName): ModelName => (m === "luna" ? "haiku" : "luna");
const toolsFor = (m: ModelName) => (m === "luna" ? ({ tools: "none" } as const) : {});

function hintsFor(inp: S2Inputs, layer: "fact" | "interp"): string[] {
  const h: string[] = [];
  if (layer === "fact") {
    h.push(inp.enabled.has("M04") ? "時系列の二重化を扱う: Event の story_order と disclosure_phase を両方埋める。" : "Event の disclosure_phase は null にする（story_order は埋める）。");
    if (inp.ms.expansion?.hints?.faction_emphasis === true) h.push("勢力（Faction）と勢力間・人物と勢力の関係を重視する。");
  }
  for (const m of inp.ms.module_selection) if (m.enabled && m.weight > 1.0) h.push(`${m.module} を重点的に扱う（重み ${m.weight}）。`);
  return h;
}

function claimsFor(inp: S2Inputs, specs: ElementSpec[]): Claim[] {
  const mods = new Set(specs.map((s) => s.module));
  // AMENDMENT 12: event-granular plot claims back the Event group (M03)
  const rel = (c: Claim) => (c.aspects ?? []).some((a) => mods.has(a as ModuleId) || (a === "plot" && mods.has("M03")));
  // AMENDMENT 12: higher-tier sources first within each group (stable), so they are seen (and cited) first
  const tierRank = (c: Claim) => Number(String((c as Claim & { best_tier?: string }).best_tier ?? "T9").slice(1)) || 9;
  const byTier = (xs: Claim[]) => xs.map((c, i) => ({ c, i })).sort((a, b) => tierRank(a.c) - tierRank(b.c) || a.i - b.i).map((x) => x.c);
  return [...byTier(inp.claims.filter(rel)), ...byTier(inp.claims.filter((c) => !rel(c)))];
}

const summarize = (d: Draft[]) => d.filter((x) => !SPECS[x._type].edge).map((x) => ({ id: x.id, type: x._type, label: String(x.label ?? "") }));

function revisionSchema(specs: ElementSpec[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["responses", "updated", "removed_ids"],
    properties: {
      responses: RESPONSES_SCHEMA,
      updated: groupSchema(specs),
      removed_ids: { type: "array", items: { type: "string" } },
    },
  };
}

async function buildLayer(ctx: StageContext, cfg: LayerConfig, maxRounds: number): Promise<StageResult> {
  const inp = loadInputs(ctx);
  const phases = readPhases(ctx).phases.map(({ id, label, order }) => ({ id, label, order }));
  const warnings: string[] = [];
  const author = cfg.author;
  const reviewer = opposite(author);
  const authorPort = port(ctx, author);
  const reviewerPort = port(ctx, reviewer);

  // other layers' drafts (interp references fact nodes)
  const prior: Draft[] = cfg.layer === "interp" ? (readJson<LayerFile | null>(ctx.workDir, NKG_FILES.factLayer, null)?.drafts ?? []) : [];
  if (cfg.layer === "interp" && !prior.length) warnings.push("interp: fact layer missing or empty — interpretive elements can only use claims");
  const taken = new Set(prior.map((d) => d.id));

  const allSpecs: ElementSpec[] = [];
  const groups: LayerFile["groups"] = [];
  let drafts: Draft[] = [];
  const renames: LayerFile["id_renames"] = [];
  let calls = 0;
  const author1 = (g: CallGroup, specs: ElementSpec[], existing: Draft[]) =>
    authorPort.call({
      task: `s2.${cfg.layer}.${g.name}`,
      prompt: authoringPrompt({
        layer: cfg.layer,
        title: inp.title,
        coverage: inp.coverageLabel,
        group: g.name,
        specs,
        phases,
        claims: claimsFor(inp, specs),
        existing: summarize(existing),
        hints: hintsFor(inp, cfg.layer),
      }),
      schema: groupSchema(specs),
      ...toolsFor(author),
      jobId: ctx.jobId,
      timeoutMs: AUTHORING_TIMEOUT_MS,
    });
  // AMENDMENT 12 (speed): groups are authored in waves; the groups of one wave run in parallel and see the drafts of the
  // earlier waves. Fact: events → (people ‖ world); interp: (reverse plot ‖ motives & arcs ‖ themes & emotion) → extras.
  const waves = (cfg.layer === "interp" ? INTERP_WAVES : FACT_WAVES).map((w) => cfg.groups.filter((g) => w.includes(g.name)));
  const inWave = new Set(waves.flat().map((g) => g.name));
  for (const g of cfg.groups) if (!inWave.has(g.name)) waves.push([g]); // any group not in a wave runs alone, in order
  const results = new Map<string, Draft[]>();
  for (const wave of waves) {
    const existing = [...prior, ...drafts];
    const settled = await Promise.allSettled(
      wave.map(async (g) => {
        const specs = enabledSpecs(g, inp.enabled);
        if (!specs.length) return null;
        const res = await author1(g, specs, existing);
        calls++;
        let got = draftsFromOutput(res.output, specs);
        // AMENDMENT 12: a group whose output lacks an element type that the claims clearly support (≥3 claims of that
        // module and nothing made, or ≥2 nodes but no edge between them) is asked once more with that note; the richer
        // of the two outputs is kept. Deterministic trigger, no stop (P-1).
        const missingKinds = expectedButMissing(specs, got, inp);
        if (missingKinds.length) {
          warnings.push(`${cfg.layer}: group ${g.name} returned no ${missingKinds.join("/")} — asked once more`);
          const again = await authorPort.call({
            task: `s2.${cfg.layer}.${g.name}`,
            prompt:
              authoringPrompt({ layer: cfg.layer, title: inp.title, coverage: inp.coverageLabel, group: g.name, specs, phases, claims: claimsFor(inp, specs), existing: summarize(existing), hints: hintsFor(inp, cfg.layer) }) +
              `\n# 前回の出力について\n- 前回は ${missingKinds.join("・")} が 0 件でした。claim から言えるものは省かずに作ってください（直接言えなければ epistemic: sfsh_analysis と based_on で）。他の型も含め、グループ全体を出し直してください。\n`,
            schema: groupSchema(specs),
            ...toolsFor(author),
            jobId: ctx.jobId,
            timeoutMs: AUTHORING_TIMEOUT_MS,
          });
          calls++;
          const got2 = draftsFromOutput(again.output, specs);
          if (expectedButMissing(specs, got2, inp).length < missingKinds.length || (expectedButMissing(specs, got2, inp).length === missingKinds.length && got2.length > got.length)) got = got2;
        }
        return got;
      }),
    );
    for (let i = 0; i < wave.length; i++) {
      const s = settled[i]!;
      if (s.status === "rejected") throw s.reason; // a failing call fails the stage as before (retry, 4.4)
      if (s.value) results.set(wave[i]!.name, s.value);
    }
    // ids are normalized in the fixed group order so the result does not depend on which call finished first
    for (const g of wave) {
      const got = results.get(g.name);
      if (!got) continue;
      renames.push(...normalizeIds(got, taken));
      drafts.push(...got);
    }
  }
  for (const g of cfg.groups) {
    const specs = enabledSpecs(g, inp.enabled);
    if (!specs.length) {
      groups.push({ name: g.name, kinds: [], called: false, elements: 0 });
      continue;
    }
    allSpecs.push(...specs);
    groups.push({ name: g.name, kinds: specs.map((s) => s.kind), called: true, elements: results.get(g.name)?.length ?? 0 });
  }
  // AMENDMENT 12 (speed): the interpretive review / revision see the claims cited by the elements first (cap 300);
  // the fact review keeps every claim (it checks for missing structure)
  const reviewClaimsFor = (state: Draft[]): Claim[] => {
    if (cfg.layer !== "interp") return inp.claims;
    const cited = new Set(state.flatMap((d) => (Array.isArray(d.claim_refs) ? (d.claim_refs as string[]) : [])));
    const first = inp.claims.filter((c) => cited.has(c.claim_id));
    return [...first, ...inp.claims.filter((c) => !cited.has(c.claim_id))].slice(0, Math.max(300, first.length));
  };

  // review loop (reviewer = opposite model, findings only; author answers every finding). §3.3, ≤ maxRounds rounds.
  const firstDraftCounts = countByType(drafts);
  const added = new Set<string>();
  const outcome = await runReviewLoop<Draft[]>({
    initial: drafts,
    maxRounds,
    ids: (s) => s.map((d) => d.id),
    review: async (state, round, rounds: ReviewRound[] = []) => {
      if (!state.length) return [];
      const r = await reviewerPort.call({
        task: `s2.${cfg.layer}.review`,
        prompt:
          layerReviewPrompt({ layer: cfg.layer, title: inp.title, elements: draftsToOutput(state, allSpecs), claims: reviewClaimsFor(state), context: summarize(prior) }) +
          priorRoundsBlock(rounds, round, maxRounds),
        schema: FINDINGS_SCHEMA,
        ...toolsFor(reviewer),
        jobId: ctx.jobId,
        timeoutMs: AUTHORING_TIMEOUT_MS,
      });
      calls++;
      return ((r.output as { findings?: RawFinding[] }).findings ?? []) as RawFinding[];
    },
    revise: async (state, findings: Finding[], round) => {
      const r = await authorPort.call({
        task: `s2.${cfg.layer}.revise`,
        prompt: revisionPrompt({ layer: cfg.layer, title: inp.title, elements: draftsToOutput(state, allSpecs), findings, claims: reviewClaimsFor(state) }) + lastRoundNote(round, maxRounds),
        schema: revisionSchema(allSpecs),
        ...toolsFor(author),
        jobId: ctx.jobId,
        timeoutMs: AUTHORING_TIMEOUT_MS,
      });
      calls++;
      const out = r.output as { responses: FindingResponse[]; updated: unknown; removed_ids: string[] };
      return { state: applyRevision(state, out, allSpecs, taken, renames, added), responses: out.responses ?? [] };
    },
  });
  const unresolved: UnresolvedEntry[] = outcome.unresolved ?? [];
  // C-2: unresolved copied_phrase → delete the element (+ edges touching it, + refs to it)
  const del = deleteDrafts(outcome.state, copiedPhraseTargets(unresolved));
  drafts = del.drafts;
  const status = { ...outcome.status };
  for (const id of added) if (status[id] === "agreed") status[id] = "revised";
  for (const id of [...del.deleted.map((d) => d.id), ...del.cascaded.map((d) => d.id)]) delete status[id];
  const advisory: AdvisoryEntry[] = advisoryFrom(unresolved, del.deleted.map((d) => d.id));
  for (const d of del.deleted) warnings.push(`${cfg.layer}: ${d.id} (${d.type}) deleted — unresolved copied_phrase (C-2)`);

  // observation d (CP-022): element types emptied by review, structural zeros. Warnings only (P-1).
  const finalCounts = countByType(drafts);
  const zeroed = Object.entries(firstDraftCounts)
    .filter(([t, n]) => n > 0 && !finalCounts[t])
    .map(([type, before]) => ({ type, before, after: 0 }));
  for (const z of zeroed) warnings.push(`review_zeroed_type: ${z.type} (${z.before} → 0)`);
  const structural = structuralZeros(finalCounts, inp.enabled, cfg.layer);
  for (const z of structural) warnings.push(`structural_zero: ${z.type}`);

  const layerFile: LayerFile = {
    layer: cfg.layer,
    author,
    reviewer,
    generated_at: ctx.now().toISOString(),
    groups,
    drafts,
    status,
    id_renames: renames,
  };
  const outLayer = writeJson(ctx.workDir, cfg.layer === "fact" ? NKG_FILES.factLayer : NKG_FILES.interpLayer, layerFile);
  const statusCounts = { agreed: 0, revised: 0, disputed: 0 };
  for (const s of Object.values(status)) statusCounts[s]++;
  const reviewFile: LayerReviewFile = {
    layer: cfg.layer,
    author,
    reviewer,
    max_rounds: maxRounds,
    rounds: outcome.rounds.map((r) => ({ round: r.round, findings: r.findings, responses: completedResponses(r) })),
    counts: outcome.counts,
    status_counts: statusCounts,
    unresolved: unresolved.map((u) => ({ target_id: u.target_id, types: u.types })),
    deleted: del.deleted.map((d) => ({ ...d, reason: "copied_phrase" as const })),
    cascade_removed: del.cascaded,
    advisory,
    first_draft_counts: firstDraftCounts,
    final_counts: finalCounts,
    zeroed_types: zeroed,
    structural_zero: structural,
  };
  const outReview = writeJson(ctx.workDir, NKG_FILES.review(cfg.layer), reviewFile);

  // preliminary finalize → rejection count for this layer (assemble does the authoritative pass)
  const layers: LayerInput[] = [];
  if (cfg.layer === "interp") {
    const f = readJson<LayerFile | null>(ctx.workDir, NKG_FILES.factLayer, null);
    if (f) layers.push({ layer: "fact", author: f.author, drafts: f.drafts, status: f.status });
  }
  layers.push({ layer: cfg.layer, author, drafts, status });
  const fin = finalizeLayers(layers, finalizeContext(inp, phases, ctx));
  const rejected = fin.rejections.filter((r) => r.layer === cfg.layer).length;
  if (rejected) warnings.push(`${cfg.layer}: ${rejected} element(s) would be rejected (no basis / invalid refs)`);
  if (renames.length) warnings.push(`${cfg.layer}: ${renames.length} id(s) renamed`);

  const outputs = [outLayer, outReview];
  const summaryOut = writeReviewSummary(ctx, warnings);
  if (summaryOut) outputs.push(summaryOut);

  ctx.log(
    `s2.${cfg.layer}: elements=${drafts.length} rounds=${outcome.counts.rounds} findings=${outcome.counts.findings} revised=${outcome.counts.revised} declined=${outcome.counts.declined} deleted=${del.deleted.length} advisory=${advisory.length} rejected=${rejected}`,
  );
  return {
    outputs,
    metrics: {
      calls,
      elements: drafts.length,
      rounds: outcome.counts.rounds,
      findings: outcome.counts.findings,
      revised: outcome.counts.revised,
      declined: outcome.counts.declined,
      unanswered: outcome.counts.unanswered,
      rejected,
      disputed_elements: statusCounts.disputed,
      deleted_copied_phrase: del.deleted.length,
      advisory: advisory.length,
      zeroed_types: zeroed.length,
      structural_zero: structural.length,
    },
    warnings,
  };
}

/** nkg/reviews/<layer>.json (also the shape S3 can use for gen/reviews/*.json; summarizeReviews reads both). */
export interface LayerReviewFile {
  layer: string;
  author: ModelName;
  reviewer: ModelName;
  max_rounds: number;
  rounds: { round: number; findings: Finding[]; responses: FindingResponse[] }[];
  counts: { findings: number; revised: number; declined: number; unanswered: number; rounds: number };
  status_counts: { agreed: number; revised: number; disputed: number };
  unresolved: { target_id: string; types: string[] }[];
  deleted: { id: string; type: string; reason: "copied_phrase" }[];
  cascade_removed: { id: string; type: string; because_of: string }[];
  advisory: AdvisoryEntry[];
  first_draft_counts: Record<string, number>;
  final_counts: Record<string, number>;
  zeroed_types: { type: string; before: number; after: number }[];
  structural_zero: { type: string; basis: string; basis_count: number }[];
}

export function countByType(drafts: Draft[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of drafts) out[d._type] = (out[d._type] ?? 0) + 1;
  return out;
}

/**
 * Structural zeros (observation d): ≥2 Characters with M01 enabled but no Relation; ≥2 Events but no Causes.
 * Only checked on the fact layer (all four types live there).
 */
export function structuralZeros(counts: Record<string, number>, enabled: Set<string>, layer: "fact" | "interp"): LayerReviewFile["structural_zero"] {
  const out: LayerReviewFile["structural_zero"] = [];
  if (layer !== "fact") return out;
  const ch = counts.Character ?? 0;
  const ev = counts.Event ?? 0;
  if (enabled.has(SPECS.Relation.module) && ch >= 2 && !(counts.Relation ?? 0)) out.push({ type: "Relation", basis: "Character", basis_count: ch });
  if (enabled.has(SPECS.Causes.module) && ev >= 2 && !(counts.Causes ?? 0)) out.push({ type: "Causes", basis: "Event", basis_count: ev });
  return out;
}

const REF_LIST_FIELDS = ["based_on", "refs", "cause_refs", "reasoning_refs", "context_refs"] as const;

/**
 * Delete elements (C-2): the elements themselves, every edge whose from/to touches a deleted node, and the
 * deleted ids from other elements' ref lists. The nullable scalar ref Relation.changed_by is nulled; required
 * scalar refs (Motive.owner, Arc.character, IconicMoment.event_ref) are left for finalize to reject (logged).
 */
export function deleteDrafts(
  drafts: Draft[],
  ids: Iterable<string>,
): { drafts: Draft[]; deleted: { id: string; type: string }[]; cascaded: { id: string; type: string; because_of: string }[] } {
  const want = new Set(ids);
  if (!want.size) return { drafts, deleted: [], cascaded: [] };
  const deleted = drafts.filter((d) => want.has(d.id)).map((d) => ({ id: d.id, type: d._type as string }));
  const gone = new Set(deleted.map((d) => d.id));
  const cascaded: { id: string; type: string; because_of: string }[] = [];
  const kept: Draft[] = [];
  for (const d of drafts) {
    if (gone.has(d.id)) continue;
    if (SPECS[d._type]?.edge) {
      const hit = [d.from, d.to].find((x) => typeof x === "string" && gone.has(x));
      if (hit) {
        cascaded.push({ id: d.id, type: d._type, because_of: String(hit) });
        continue;
      }
    }
    kept.push(d);
  }
  for (const c of cascaded) gone.add(c.id);
  const out = kept.map((d) => {
    const n: Draft = { ...d };
    for (const k of REF_LIST_FIELDS) if (Array.isArray(n[k])) n[k] = (n[k] as unknown[]).filter((x) => !(typeof x === "string" && gone.has(x)));
    if (typeof n.changed_by === "string" && gone.has(n.changed_by)) n.changed_by = null;
    return n;
  });
  return { drafts: out, deleted, cascaded };
}

/** Refresh nkg/review_summary.json + work.json review_stats; failures become warnings (P-1). */
function writeReviewSummary(ctx: StageContext, warnings: string[]): string | null {
  try {
    return summarizeReviews(ctx.workDir, ctx.now()).output;
  } catch (e) {
    warnings.push(`review summary not written: ${(e as Error).message}`);
    return null;
  }
}

function applyRevision(
  state: Draft[],
  out: { updated: unknown; removed_ids: string[] },
  specs: ElementSpec[],
  taken: Set<string>,
  renames: LayerFile["id_renames"],
  added: Set<string>,
): Draft[] {
  const removed = new Set((out.removed_ids ?? []).map((x) => String(x).trim().toLowerCase()));
  const next = state.filter((d) => !removed.has(d.id)).map((d) => ({ ...d }));
  const index = new Map(next.map((d, i) => [d.id, i] as const));
  const fresh: Draft[] = [];
  for (const u of draftsFromOutput(out.updated, specs)) {
    const id = String(u.id ?? "").trim().toLowerCase();
    const i = index.get(id);
    if (i !== undefined && next[i]._type === u._type) next[i] = { ...u, id };
    else fresh.push(u);
  }
  const takenNow = new Set([...taken, ...next.map((d) => d.id)]);
  renames.push(...normalizeIds(fresh, takenNow));
  for (const f of fresh) {
    taken.add(f.id);
    added.add(f.id);
  }
  return [...next, ...fresh];
}

function finalizeContext(inp: S2Inputs, phases: { id: string; label?: string }[], ctx: StageContext): FinalizeContext {
  return {
    claims: inp.claimsById,
    sources: new Map(inp.cards.map((c) => [c.source_id, { source_id: c.source_id, tier: c.tier, site_key: c.site_key || c.domain || c.source_id }] as const)),
    phaseIds: new Set(phases.map((p) => p.id)),
    phaseByLabel: new Map(phases.filter((p) => p.label).map((p) => [p.label!.normalize("NFKC").trim(), p.id])),
    enabled: inp.enabled,
    defaultCoverage: ctx.range[0]?.label || "全体",
  };
}

/** Fact layer (M01, M03, M04, M05, M08, M09, M12 when enabled): Luna → Haiku review → Luna revise. */
export function buildFactLayer(ctx: StageContext, maxRounds = REVIEW_MAX_ROUNDS): Promise<StageResult> {
  return buildLayer(ctx, FACT, maxRounds);
}

/** Interpretive layer (M02, M06, M07, M10, M11 when enabled + IconicMoment / Interpretation / Quiz): Haiku → Luna review → Haiku revise. */
export function buildInterpLayer(ctx: StageContext, maxRounds = REVIEW_MAX_ROUNDS): Promise<StageResult> {
  return buildLayer(ctx, INTERP, maxRounds);
}

// ------------------------------------------------------------------ assemble
const MEDIA = new Set(["novel", "manga", "anime", "film", "drama", "game", "other"]);
const COPYRIGHT = new Set(["in_copyright", "public_domain", "unknown"]);

function buildWork(ctx: StageContext, inp: S2Inputs, phases: Phase[]): NkgWork {
  const w = readJson<Record<string, any> | null>(ctx.workDir, "work.json", null) ?? {};
  const creators = (Array.isArray(w.creators) ? w.creators : [])
    .map((c: unknown) => (typeof c === "string" ? { name: c, role: null } : c && typeof c === "object" ? { name: String((c as any).name ?? ""), role: typeof (c as any).role === "string" ? (c as any).role : null } : null))
    .filter((c: { name: string } | null): c is { name: string; role: string | null } => !!c && !!c.name);
  const titleAlt = (Array.isArray(w.aliases) ? w.aliases : [])
    .filter((a: any) => a && a.attested === true && a.kind !== "input" && typeof a.text === "string")
    .map((a: any) => a.text as string);
  const bib = w.bibliographic && typeof w.bibliographic === "object" ? w.bibliographic : {};
  const bibSources = [...new Set(inp.claims.filter((c) => (c.aspects ?? []).includes("bibliographic")).flatMap((c) => c.source_ids))];
  const rights = w.rights && typeof w.rights === "object" ? w.rights : {};
  const coverage = ctx.range.length
    ? ctx.range.map((r) => ({ unit: r.unit, from: r.from, to: r.to, label: r.label || (r.unit === "whole" ? "全体" : "") }))
    : [{ unit: "whole" as const, from: null, to: null, label: "全体" }];
  return {
    work_id: ctx.workId,
    title: inp.title,
    title_alt: [...new Set<string>(titleAlt)],
    creators,
    medium: MEDIA.has(w.medium) ? w.medium : "other",
    bibliographic: {
      publisher: typeof bib.publisher === "string" ? bib.publisher : null,
      first_release: typeof bib.first_release === "string" ? bib.first_release : null,
      status: ["completed", "ongoing", "unknown"].includes(bib.status) ? bib.status : "unknown",
      source_ids: bibSources,
    },
    genres: (inp.ms.genres?.accepted ?? []).map((g) => g.slug),
    coverage,
    publish_mode: w.publish_mode === "Restricted" ? "Restricted" : "Public",
    rights: {
      state: typeof rights.state === "string" ? rights.state : "unchecked",
      copyright_status: COPYRIGHT.has(rights.copyright_status) ? rights.copyright_status : "unknown",
      holder_policy_note: typeof rights.holder_policy_note === "string" ? rights.holder_policy_note : "",
      source_ids: Array.isArray(rights.source_ids) ? rights.source_ids.filter((s: unknown) => typeof s === "string") : [],
    },
    module_selection: inp.ms.module_selection,
    phases,
  };
}

export async function assembleNkg(ctx: StageContext): Promise<StageResult> {
  const inp = loadInputs(ctx);
  const phases = readPhases(ctx).phases.map(({ id, label, order }) => ({ id, label, order }));
  const warnings: string[] = [];
  const fact = readJson<LayerFile | null>(ctx.workDir, NKG_FILES.factLayer, null);
  const interp = readJson<LayerFile | null>(ctx.workDir, NKG_FILES.interpLayer, null);
  const layers: LayerInput[] = [];
  if (fact) layers.push({ layer: "fact", author: fact.author, drafts: fact.drafts, status: fact.status });
  else warnings.push("assemble: fact layer not generated");
  if (interp) layers.push({ layer: "interp", author: interp.author, drafts: interp.drafts, status: interp.status });
  else warnings.push("assemble: interp layer not generated");

  const fin = finalizeLayers(layers, finalizeContext(inp, phases, ctx));

  // gaps: insufficient modules from selection + enabled modules that ended up empty
  const gaps: Gap[] = [...(inp.ms.gaps ?? [])];
  const has = (m: string) => (m === "M04" ? fin.nodes.some((n) => n.type === "Event" && n.disclosure_phase !== null) : fin.nodes.some((n) => n.module === m));
  for (const m of [...FACT_MODULES, ...INTERP_MODULES].sort()) {
    if (!inp.enabled.has(m) || has(m)) continue;
    const layerMissing = FACT_MODULES.includes(m) ? !fact : !interp;
    gaps.push({ module: m, what: layerMissing ? "層が未生成" : "採用できる要素が無かった（根拠不足で棄却または未生成）", reason: "insufficient_sources" });
  }
  for (const t of ["IconicMoment", "Interpretation", "Quiz"] as const) {
    if (!fin.nodes.some((n) => n.type === t)) gaps.push({ module: "extra", what: `${t} 未生成（根拠不足）`, reason: "insufficient_sources" });
  }

  const nkg: Nkg = {
    schema_version: "1.0",
    work: buildWork(ctx, inp, phases),
    sources: inp.cards.map(toNkgSource),
    nodes: fin.nodes,
    edges: fin.edges,
    gaps,
  };
  const outNkg = writeJson(ctx.workDir, NKG_FILES.nkg, nkg);
  const { validation, output: outVal } = writeValidation(ctx.workDir, nkg, ctx.now());
  const report = {
    generated_at: ctx.now().toISOString(),
    counts: {
      nodes: fin.nodes.length,
      edges: fin.edges.length,
      rejected: fin.rejections.length,
      gaps: gaps.length,
      public_eligible: Object.values(validation.elements).filter((e) => e.public_eligible).length,
    },
    rejections: fin.rejections,
    notes: fin.notes,
  };
  const outReport = writeJson(ctx.workDir, NKG_FILES.buildReport, report);
  if (!validation.ok) warnings.push(`nkg validation failed: ${validation.errors.length} error(s) — see ${outVal}`);
  if (validation.warnings.length) warnings.push(`nkg soft-limit warnings: ${validation.warnings.length}`);
  if (fin.rejections.length) warnings.push(`assemble: ${fin.rejections.length} element(s) rejected (see ${outReport})`);
  ctx.log(`s2.assemble: nodes=${fin.nodes.length} edges=${fin.edges.length} rejected=${fin.rejections.length} gaps=${gaps.length} valid=${validation.ok}`);
  return {
    outputs: [outNkg, outVal, outReport],
    metrics: {
      nodes: fin.nodes.length,
      edges: fin.edges.length,
      rejected: fin.rejections.length,
      rejected_fact: countLayer(fin.rejections, "fact"),
      rejected_interp: countLayer(fin.rejections, "interp"),
      gaps: gaps.length,
      validation_ok: validation.ok ? 1 : 0,
      validation_errors: validation.errors.length,
      validation_warnings: validation.warnings.length,
      public_eligible: report.counts.public_eligible,
    },
    warnings,
  };
}

const countLayer = (r: Rejection[], layer: string) => r.filter((x) => x.layer === layer).length;

/**
 * AMENDMENT 12: element types a group should have produced but did not (deterministic): a node type whose module has
 * ≥3 active claims (Event / Character / Secret / WorldRule / Setup / Context …) with zero elements, and the edge that
 * connects ≥2 such nodes (Causes between Events, Relation between Characters, Knows for Secrets) with zero elements.
 */
export function expectedButMissing(specs: ElementSpec[], got: Draft[], inp: { claims: Claim[] }): string[] {
  const count = (k: string) => got.filter((d) => d._type === k).length;
  const claimsOf = (m: string) => inp.claims.filter((c) => (c.aspects ?? []).includes(m) || (m === "M03" && (c.aspects ?? []).includes("plot"))).length;
  const kinds = new Set(specs.map((s) => s.kind as string));
  const out: string[] = [];
  for (const s of specs) {
    if (s.edge || s.module === "extra") continue;
    if (s.kind === "Faction") continue; // optional by nature
    if (count(s.kind) === 0 && claimsOf(s.module) >= 3) out.push(s.kind);
  }
  const pairs: [string, string, number][] = [["Causes", "Event", 2], ["Relation", "Character", 2], ["Knows", "Secret", 1]];
  for (const [edge, node, min] of pairs) if (kinds.has(edge) && count(node) >= min && count(edge) === 0) out.push(edge);
  return out;
}
