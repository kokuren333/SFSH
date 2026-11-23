/**
 * WP-2.4 page text and quiz (REQUIREMENTS §3.2 S3 row, §3.3): Haiku writes every page text block from the
 * public projection only; Luna reviews against the projection elements and the claims behind them
 * (findings only, max 2 rounds). Code then:
 *  - deletes blocks with an unresolved `copied_phrase` (C-2); other unresolved findings → advisory, block `disputed`;
 *  - runs the deterministic 30-char guard against saved source raw text: one Haiku rewrite, then sentence drop;
 *  - keeps only based_on ids present in the projection (blocks left without any basis are dropped, C-7);
 *  - block spoiler = max(declared, based_on spoilers); epistemic = canon only if declared canon and all based_on canon.
 * Outputs (internal): gen/pages/<page>.json, gen/reviews/pages.json, gen/write_report.json.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlotNode, PublicWork, QuizItem, TextBlock } from "../../../site/src/public-types.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { readActiveClaims, readJson, readSourceCards, writeJson } from "../nkg/io.ts";
import {
  FINDINGS_SCHEMA,
  REVIEW_MAX_ROUNDS,
  advisoryFrom,
  completedResponses,
  copiedPhraseTargets,
  runReviewLoop,
  type FindingResponse,
  type RawFinding,
  type ReviewOutcome,
  type UnresolvedEntry,
} from "../nkg/review.ts";
import type { Epistemic, Nkg, ReviewState, Spoiler } from "../nkg/types.ts";
import { hasVerbatimRun, normKey, windows } from "../research/textMatch.ts";
import { sha256Hex } from "../util/hash.ts";
import { GEN_FILES, claimIdsOf, maxSpoiler, type PageKey } from "./io.ts";
import { citableIds } from "./project.ts";
import {
  REWRITE_SCHEMA,
  WRITE_REVISION_SCHEMA,
  WRITE_SCHEMA,
  rewritePrompt,
  writePrompt,
  writeReviewPrompt,
  writeRevisePrompt,
  type ReviewUnitView,
} from "./prompts.ts";
import { S3_TIMEOUT_MS } from "./tags.ts";

/** §5.1 A-1 / PLAN M1 §2: continuous verbatim match threshold (normalized chars). */
export const VERBATIM_THRESHOLD = 30;
export const MAX_OVERVIEW_BLOCKS = 4;

type Slot = "overview" | "relations" | "reverse_plot" | "matrix" | "intro" | "quiz";
type DeclaredEpistemic = "canon" | "sfsh_analysis";

export interface Unit {
  id: string;
  page: PageKey;
  slot: Slot;
  heading: string | null;
  paragraphs: string[];
  quiz: { quiz_type: QuizItem["quiz_type"]; question: string; answer: string; explanation: string } | null;
  based_on: string[];
  /** Haiku's declared values (code computes the final ones). */
  spoiler: Spoiler;
  epistemic: DeclaredEpistemic;
}

export interface InternalBlock extends TextBlock {
  slot: Slot;
  authored_by: "haiku";
  reviewed_by: "luna";
  review: ReviewState;
}
export interface InternalQuiz extends QuizItem {
  authored_by: "haiku";
  reviewed_by: "luna";
  review: ReviewState;
}
export interface PageFile {
  page: PageKey;
  generated_at: string;
  blocks: InternalBlock[];
  items?: InternalQuiz[];
}

export interface GuardRecord {
  id: string;
  flagged_sentences: number;
  rewritten: boolean;
  still_flagged_after_rewrite: number;
  dropped_sentences: { field: string; index: number; chars: number; sha256: string }[];
  dropped_unit: boolean;
}

export interface WriteReport {
  generated_at: string;
  units_written: number;
  removed_by_author: string[];
  deleted_copied_phrase: string[];
  dropped_no_basis: string[];
  based_on_filtered: { id: string; removed: string[] }[];
  guard: { sources_checked: number; sources_missing: string[]; threshold: number; records: GuardRecord[] };
  warnings: string[];
}

const SPOILERS = new Set(["none", "mid", "ending"]);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const asSpoiler = (v: unknown): Spoiler => (SPOILERS.has(String(v)) ? (v as Spoiler) : "none");
const asEpi = (v: unknown): DeclaredEpistemic => (v === "canon" ? "canon" : "sfsh_analysis");
const paras = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const ids = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))];

// ------------------------------------------------------------------ inputs for the models
/**
 * Compact JSON of the projection's public elements (no grades / source refs / sources). Everything here is
 * already in the PublicWork, so the writer never sees non-public content (CP-026 adds `elements` and `analysis`).
 */
export function elementsForPrompt(pw: PublicWork): string {
  const plot = (n: PlotNode): unknown => ({
    id: n.id,
    level: n.level,
    factor_kind: n.factor_kind,
    label: n.label,
    summary: n.summary,
    analysis: n.analysis,
    epistemic: n.epistemic,
    spoiler: n.spoiler,
    children: n.children.map(plot),
  });
  const strip = <T extends { grade?: unknown; source_refs?: unknown }>(x: T) => {
    const { grade: _g, source_refs: _s, ...rest } = x;
    return rest;
  };
  return JSON.stringify({
    work: { title: pw.work.title, medium: pw.work.medium, coverage: pw.work.coverage_label, genres: pw.work.genres, creators: pw.work.creators.map((c) => c.name) },
    phases: pw.phases,
    characters: pw.viz.relations.characters.map((c) => ({ id: c.id, label: c.label, summary: c.summary, faction: c.faction, epistemic: c.epistemic, spoiler: c.spoiler })),
    factions: pw.viz.relations.factions,
    relations: pw.viz.relations.relations.map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      kind: r.kind,
      valence: r.valence,
      phase_from: r.phase_from,
      phase_to: r.phase_to,
      changed_by: r.changed_by_label,
      epistemic: r.epistemic,
      spoiler: r.spoiler,
    })),
    reverse_plot: pw.viz.reverse_plot.trees.map(plot),
    knowledge_matrix: pw.viz.matrix,
    themes: pw.pages.themes.items.map((t) => ({ id: t.id, label: t.label, question: t.question, tension: t.tension, values: t.values, summary: t.summary, analysis: t.analysis, epistemic: t.epistemic, spoiler: t.spoiler })),
    context: pw.pages.context.items.map((c) => ({ id: c.id, kind: c.kind, label: c.label, summary: c.summary, analysis: c.analysis, epistemic: c.epistemic, spoiler: c.spoiler })),
    iconic: pw.pages.context.iconic.map((i) => ({ id: i.id, label: i.label, why_famous: i.why_famous, analysis: i.analysis, epistemic: i.epistemic, spoiler: i.spoiler })),
    interpretations: pw.pages.interpretations.items.map((i) => ({ id: i.id, topic: i.topic, positions: i.positions.map((p) => ({ claim: p.claim, epistemic: p.epistemic })), spoiler: i.spoiler })),
    events: pw.elements.events.map(strip),
    motives: pw.elements.motives.map(strip),
    arcs: pw.elements.arcs.map(strip),
    world_rules: pw.elements.world_rules.map(strip),
    setups: pw.elements.setups.map(strip),
    emotion_beats: pw.elements.emotion_beats.map(strip),
  });
}

function unitText(u: Unit): string {
  if (u.quiz) return `問: ${u.quiz.question}\n答: ${u.quiz.answer}\n解説: ${u.quiz.explanation}`;
  return [u.heading ? `【${u.heading}】` : "", ...u.paragraphs].filter(Boolean).join("\n");
}
const view = (u: Unit): ReviewUnitView => ({ id: u.id, page: `${u.page}/${u.slot}`, text: unitText(u), based_on: u.based_on, spoiler: u.spoiler, epistemic: u.epistemic });

/** Turn Haiku's write output into units (structure fixed by code: ids, slots, quiz ids). */
export function unitsFromWrite(out: unknown, pw: PublicWork): Unit[] {
  const o = (out ?? {}) as Record<string, unknown>;
  const units: Unit[] = [];
  const block = (b: Record<string, unknown>, id: string, page: PageKey, slot: Slot): Unit | null => {
    const p = paras(b.paragraphs);
    if (!p.length) return null;
    return { id, page, slot, heading: str(b.heading) || null, paragraphs: p, quiz: null, based_on: ids(b.based_on), spoiler: asSpoiler(b.spoiler), epistemic: asEpi(b.epistemic) };
  };
  let n = 0;
  for (const b of (Array.isArray(o.overview) ? o.overview : []) as Record<string, unknown>[]) {
    if (n >= MAX_OVERVIEW_BLOCKS) break;
    const u = block(b, `ov${String(n + 1).padStart(2, "0")}`, "overview", "overview");
    if (u) {
      units.push(u);
      n++;
    }
  }
  const present = { relations: pw.viz.relations.characters.length > 0, reverse_plot: pw.viz.reverse_plot.trees.length > 0, matrix: pw.viz.matrix !== null };
  for (const fig of ["relations", "reverse_plot", "matrix"] as const) {
    if (!present[fig]) continue;
    const b = ((Array.isArray(o.figure_notes) ? o.figure_notes : []) as Record<string, unknown>[]).find((x) => x?.figure === fig);
    const u = b ? block(b, `fn_${fig}`, "figure_notes", fig) : null;
    if (u) units.push(u);
  }
  const hasItems = { themes: pw.pages.themes.items.length > 0, context: pw.pages.context.items.length + pw.pages.context.iconic.length > 0, interpretations: pw.pages.interpretations.items.length > 0 };
  for (const page of ["themes", "context", "interpretations"] as const) {
    if (!hasItems[page]) continue;
    const b = ((Array.isArray(o.intros) ? o.intros : []) as Record<string, unknown>[]).find((x) => x?.page === page);
    const u = b ? block(b, `${page}_intro01`, page, "intro") : null;
    if (u) units.push(u);
  }
  const written = new Map(((Array.isArray(o.quiz) ? o.quiz : []) as Record<string, unknown>[]).map((q) => [str(q?.quiz_id), q] as const));
  for (const q of pw.pages.quiz) {
    const w = written.get(q.id);
    const question = str(w?.question) || q.question;
    const answer = str(w?.answer) || q.answer;
    const explanation = str(w?.explanation) || q.explanation;
    if (!question || !answer) continue;
    units.push({
      id: q.id,
      page: "quiz",
      slot: "quiz",
      heading: null,
      paragraphs: [],
      quiz: { quiz_type: q.quiz_type, question, answer, explanation },
      based_on: w ? ids(w.based_on) : q.based_on,
      spoiler: w ? asSpoiler(w.spoiler) : q.spoiler,
      epistemic: "sfsh_analysis",
    });
  }
  return units;
}

/** Apply a Haiku revision (updated units by id, removed ids). New ids are ignored. */
export function applyWriteRevision(state: Unit[], out: unknown, removedLog: string[]): Unit[] {
  const o = (out ?? {}) as { updated?: Record<string, unknown>[]; removed_ids?: unknown[] };
  const removed = new Set(ids(o.removed_ids));
  for (const r of removed) if (state.some((u) => u.id === r)) removedLog.push(r);
  const next = state.filter((u) => !removed.has(u.id)).map((u) => ({ ...u, quiz: u.quiz ? { ...u.quiz } : null }));
  for (const upd of o.updated ?? []) {
    const u = next.find((x) => x.id === str(upd?.id));
    if (!u) continue;
    if (u.quiz) {
      if (str(upd.question)) u.quiz.question = str(upd.question);
      if (str(upd.answer)) u.quiz.answer = str(upd.answer);
      if (str(upd.explanation)) u.quiz.explanation = str(upd.explanation);
    } else {
      const p = paras(upd.paragraphs);
      if (p.length) u.paragraphs = p;
      if ("heading" in upd) u.heading = str(upd.heading) || null;
    }
    if (Array.isArray(upd.based_on)) u.based_on = ids(upd.based_on);
    if (upd.spoiler !== undefined) u.spoiler = asSpoiler(upd.spoiler);
    if (upd.epistemic !== undefined && !u.quiz) u.epistemic = asEpi(upd.epistemic);
  }
  return next;
}

// ------------------------------------------------------------------ 30-char guard
export function splitSentences(p: string): string[] {
  return (p.match(/[^。！？!?\n]+[。！？!?」』）)]*|[。！？!?]+/g) ?? []).filter((s) => s.trim());
}

interface SourceIndex {
  windows: Set<string>;
  checked: number;
  missing: string[];
}

export function buildSourceIndex(workDir: string): SourceIndex {
  const set = new Set<string>();
  const missing: string[] = [];
  let checked = 0;
  const root = path.resolve(workDir);
  for (const c of readSourceCards(workDir)) {
    const rel = c.raw_text_path || `research/raw/${c.source_id}.txt`;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !existsSync(abs)) {
      missing.push(c.source_id);
      continue;
    }
    for (const w of windows(normKey(readFileSync(abs, "utf8")), VERBATIM_THRESHOLD)) set.add(w);
    checked++;
  }
  return { windows: set, checked, missing };
}

type Field = { field: string; sentences: string[] };
function unitFields(u: Unit): Field[] {
  if (u.quiz) return (["question", "answer", "explanation"] as const).map((f) => ({ field: f, sentences: splitSentences(u.quiz![f]) }));
  return u.paragraphs.map((p, i) => ({ field: `paragraphs[${i}]`, sentences: splitSentences(p) }));
}
function flaggedSentences(u: Unit, idx: Set<string>): { field: string; index: number; text: string }[] {
  const out: { field: string; index: number; text: string }[] = [];
  for (const f of unitFields(u)) f.sentences.forEach((s, i) => (hasVerbatimRun(s, idx, VERBATIM_THRESHOLD) ? out.push({ field: f.field, index: i, text: s }) : null));
  if (u.heading && hasVerbatimRun(u.heading, idx, VERBATIM_THRESHOLD)) out.push({ field: "heading", index: 0, text: u.heading });
  return out;
}

/** Drop every flagged sentence; returns null when nothing is left of the unit. */
function dropFlagged(u: Unit, idx: Set<string>, rec: GuardRecord): Unit | null {
  const keep = (s: string, field: string, index: number) => {
    if (!hasVerbatimRun(s, idx, VERBATIM_THRESHOLD)) return true;
    rec.dropped_sentences.push({ field, index, chars: [...s].length, sha256: sha256Hex(s).slice(0, 16) });
    return false;
  };
  const next: Unit = { ...u, quiz: u.quiz ? { ...u.quiz } : null };
  if (next.heading && !keep(next.heading, "heading", 0)) next.heading = null;
  if (next.quiz) {
    for (const f of ["question", "answer", "explanation"] as const) next.quiz[f] = splitSentences(next.quiz[f]).filter((s, i) => keep(s, f, i)).join("");
    if (!next.quiz.question || !next.quiz.answer) return null;
    return next;
  }
  next.paragraphs = next.paragraphs.map((p, pi) => splitSentences(p).filter((s, i) => keep(s, `paragraphs[${pi}]`, i)).join("")).filter((p) => p.trim());
  return next.paragraphs.length ? next : null;
}

// ------------------------------------------------------------------ stage
function reviewClaims(workDir: string, pw: PublicWork) {
  const nkg = readJson<Nkg | null>(workDir, "nkg/nkg.json", null);
  const cite = citableIds(pw);
  const want: string[] = [];
  for (const el of [...(nkg?.nodes ?? []), ...(nkg?.edges ?? [])]) {
    if (!cite.has(el.id)) continue;
    for (const c of claimIdsOf(el.meta?.provenance)) if (!want.includes(c)) want.push(c);
    if (el.type === "Interpretation") for (const p of el.positions ?? []) for (const c of claimIdsOf(p.provenance)) if (!want.includes(c)) want.push(c);
  }
  const active = new Map(readActiveClaims(workDir).map((c) => [c.claim_id, c] as const));
  return want.map((id) => active.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
}

function unresolvedOf<S>(o: ReviewOutcome<S>): UnresolvedEntry[] {
  if (o.unresolved) return o.unresolved;
  // fallback for an older review.ts: derive from the last round that targeted each disputed id
  const out: UnresolvedEntry[] = [];
  for (const [id, st] of Object.entries(o.status)) {
    if (st !== "disputed") continue;
    const last = [...o.rounds].reverse().find((r) => r.findings.some((f) => f.target_id === id));
    const open = (last?.findings ?? []).filter((f) => f.target_id === id && last!.responses.find((x) => x.finding_id === f.finding_id)?.action !== "revised");
    out.push({ target_id: id, types: [...new Set(open.map((f) => f.type))], findings: open });
  }
  return out;
}

export async function writePages(ctx: StageContext): Promise<StageResult> {
  const pw = readJson<PublicWork | null>(ctx.workDir, GEN_FILES.projection, null);
  if (!pw) throw new Error(`S3 write: ${GEN_FILES.projection} missing — run projectPublic first`);
  const cite = citableIds(pw);
  const elements = elementsForPrompt(pw);
  const title = pw.work.title;
  const warnings: string[] = [];
  let calls = 0;

  // 1) Haiku writes everything from the projection only
  const w = await ctx.haiku.call({
    task: "s3.write",
    prompt: writePrompt({
      title,
      elements,
      figures: { relations: pw.viz.relations.characters.length > 0, reverse_plot: pw.viz.reverse_plot.trees.length > 0, matrix: pw.viz.matrix !== null },
      intros: {
        themes: pw.pages.themes.items.length > 0,
        context: pw.pages.context.items.length + pw.pages.context.iconic.length > 0,
        interpretations: pw.pages.interpretations.items.length > 0,
      },
      quiz: pw.pages.quiz,
    }),
    schema: WRITE_SCHEMA,
    jobId: ctx.jobId,
    timeoutMs: S3_TIMEOUT_MS,
  });
  calls++;
  const written = unitsFromWrite(w.output, pw);
  const unitsWritten = written.length;

  // 2) Luna reviews (findings only), Haiku revises — max 2 rounds
  const claims = reviewClaims(ctx.workDir, pw);
  const removedByAuthor: string[] = [];
  const outcome = await runReviewLoop<Unit[]>({
    initial: written,
    maxRounds: REVIEW_MAX_ROUNDS,
    ids: (s) => s.map((u) => u.id),
    review: async (state, round, prior) => {
      if (!state.length) return [];
      const r = await ctx.luna.call({
        task: "s3.write.review",
        prompt: writeReviewPrompt({ title, units: state.map(view), elements, claims, prior, round, maxRounds: REVIEW_MAX_ROUNDS }),
        schema: FINDINGS_SCHEMA,
        tools: "none",
        jobId: ctx.jobId,
        timeoutMs: S3_TIMEOUT_MS,
      });
      calls++;
      return ((r.output as { findings?: RawFinding[] }).findings ?? []) as RawFinding[];
    },
    revise: async (state, findings, round) => {
      const r = await ctx.haiku.call({
        task: "s3.write.revise",
        prompt: writeRevisePrompt({ title, units: state.map(view), findings, elements, round, maxRounds: REVIEW_MAX_ROUNDS }),
        schema: WRITE_REVISION_SCHEMA,
        jobId: ctx.jobId,
        timeoutMs: S3_TIMEOUT_MS,
      });
      calls++;
      const out = r.output as { responses?: FindingResponse[] };
      return { state: applyWriteRevision(state, r.output, removedByAuthor), responses: out.responses ?? [] };
    },
  });
  const unresolved = unresolvedOf(outcome);
  const deleted = copiedPhraseTargets(unresolved).filter((id) => outcome.state.some((u) => u.id === id));
  const advisory = advisoryFrom(unresolved, deleted);
  let units = outcome.state.filter((u) => !deleted.includes(u.id));

  // 3) deterministic 30-char guard against saved source text: one rewrite, then sentence drop
  const src = buildSourceIndex(ctx.workDir);
  if (src.missing.length) warnings.push(`write: raw text missing for ${src.missing.length} source(s) — not checked: ${src.missing.join(", ")}`);
  const records: GuardRecord[] = [];
  const flagged = units.map((u) => ({ u, f: flaggedSentences(u, src.windows) })).filter((x) => x.f.length);
  if (flagged.length) {
    let rewritten = new Map<string, Record<string, unknown>>();
    try {
      const r = await ctx.haiku.call({
        task: "s3.write.rewrite",
        prompt: rewritePrompt({ title, units: flagged.map(({ u, f }) => ({ id: u.id, text: unitText(u), flagged: f.map((x) => x.text), isQuiz: !!u.quiz })) }),
        schema: REWRITE_SCHEMA,
        jobId: ctx.jobId,
        timeoutMs: S3_TIMEOUT_MS,
      });
      calls++;
      rewritten = new Map(((r.output as { units?: Record<string, unknown>[] }).units ?? []).map((x) => [str(x?.id), x] as const));
    } catch (e) {
      warnings.push(`write: rewrite call failed (${(e as Error).message.slice(0, 160)}) — flagged sentences are dropped`);
    }
    const flaggedIds = new Map(flagged.map(({ u, f }) => [u.id, f.length] as const));
    const next: Unit[] = [];
    for (const u0 of units) {
      if (!flaggedIds.has(u0.id)) {
        next.push(u0);
        continue;
      }
      const rw = rewritten.get(u0.id);
      let u: Unit = { ...u0, quiz: u0.quiz ? { ...u0.quiz } : null };
      if (rw) {
        if (u.quiz) for (const f of ["question", "answer", "explanation"] as const) u.quiz[f] = str(rw[f]) || u.quiz[f];
        else if (paras(rw.paragraphs).length) u.paragraphs = paras(rw.paragraphs);
      }
      const rec: GuardRecord = { id: u.id, flagged_sentences: flaggedIds.get(u.id)!, rewritten: !!rw, still_flagged_after_rewrite: 0, dropped_sentences: [], dropped_unit: false };
      rec.still_flagged_after_rewrite = flaggedSentences(u, src.windows).length;
      const kept = rec.still_flagged_after_rewrite ? dropFlagged(u, src.windows, rec) : u;
      if (kept) next.push(kept);
      else rec.dropped_unit = true;
      records.push(rec);
    }
    units = next;
  }

  // 4) based_on → projection ids only; no basis → dropped (C-7). Quiz falls back to the node's refs.
  const basedOnFiltered: WriteReport["based_on_filtered"] = [];
  const droppedNoBasis: string[] = [];
  const projQuiz = new Map(pw.pages.quiz.map((q) => [q.id, q] as const));
  const finalUnits: Unit[] = [];
  for (const u of units) {
    const kept = u.based_on.filter((id) => cite.has(id) && id !== u.id);
    const removed = u.based_on.filter((id) => !kept.includes(id));
    if (removed.length) basedOnFiltered.push({ id: u.id, removed });
    let based = kept;
    if (!based.length && u.quiz) based = projQuiz.get(u.id)?.based_on ?? [];
    if (!based.length && !u.quiz) {
      droppedNoBasis.push(u.id);
      continue;
    }
    finalUnits.push({ ...u, based_on: based });
  }

  // 5) finalize spoiler / epistemic and write the internal page files
  const now = ctx.now().toISOString();
  const statusOf = (id: string): ReviewState => outcome.status[id] ?? "agreed";
  const spoilerOf = (u: Unit) => maxSpoiler(u.spoiler, ...u.based_on.map((id) => cite.get(id)?.spoiler));
  const epistemicOf = (u: Unit): Epistemic => (u.epistemic === "canon" && u.based_on.length > 0 && u.based_on.every((id) => cite.get(id)?.epistemic === "canon") ? "canon" : "sfsh_analysis");
  const toBlock = (u: Unit): InternalBlock => ({
    id: u.id,
    heading: u.heading,
    paragraphs: u.paragraphs,
    spoiler: spoilerOf(u),
    based_on: u.based_on,
    epistemic: epistemicOf(u),
    slot: u.slot,
    authored_by: "haiku",
    reviewed_by: "luna",
    review: statusOf(u.id),
  });
  const outputs: string[] = [];
  for (const page of ["overview", "figure_notes", "themes", "context", "interpretations"] as const) {
    const file: PageFile = { page, generated_at: now, blocks: finalUnits.filter((u) => u.page === page && !u.quiz).map(toBlock) };
    outputs.push(writeJson(ctx.workDir, GEN_FILES.page(page), file));
  }
  const quizItems: InternalQuiz[] = finalUnits
    .filter((u) => u.quiz)
    .map((u) => ({
      id: u.id,
      quiz_type: u.quiz!.quiz_type,
      question: u.quiz!.question,
      answer: u.quiz!.answer,
      explanation: u.quiz!.explanation,
      based_on: u.based_on,
      spoiler: spoilerOf(u),
      authored_by: "haiku",
      reviewed_by: "luna",
      review: statusOf(u.id),
    }));
  outputs.push(writeJson(ctx.workDir, GEN_FILES.page("quiz"), { page: "quiz", generated_at: now, blocks: [], items: quizItems } satisfies PageFile));

  outputs.push(
    writeJson(ctx.workDir, GEN_FILES.reviewPages, {
      layer: "pages",
      author: "haiku",
      reviewer: "luna",
      max_rounds: REVIEW_MAX_ROUNDS,
      rounds: outcome.rounds.map((r) => ({ round: r.round, findings: r.findings, responses: completedResponses(r) })),
      counts: outcome.counts,
      status: outcome.status,
      // over units kept after the copied_phrase deletion (read by nkg/reviewSummary.ts)
      status_counts: Object.entries(outcome.status)
        .filter(([id]) => !deleted.includes(id))
        .reduce((m, [, s]) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), { agreed: 0, revised: 0, disputed: 0 } as Record<string, number>),
      unresolved,
      deleted: deleted.map((id) => ({ id, reason: "copied_phrase" })),
      advisory,
    }),
  );
  const report: WriteReport = {
    generated_at: now,
    units_written: unitsWritten,
    removed_by_author: removedByAuthor,
    deleted_copied_phrase: deleted,
    dropped_no_basis: droppedNoBasis,
    based_on_filtered: basedOnFiltered,
    guard: { sources_checked: src.checked, sources_missing: src.missing, threshold: VERBATIM_THRESHOLD, records },
    warnings,
  };
  outputs.push(writeJson(ctx.workDir, GEN_FILES.writeReport, report));

  if (deleted.length) warnings.push(`write: ${deleted.length} block(s) deleted for unresolved copied_phrase: ${deleted.join(", ")}`);
  if (droppedNoBasis.length) warnings.push(`write: ${droppedNoBasis.length} block(s) dropped (no public basis): ${droppedNoBasis.join(", ")}`);
  if (advisory.length) warnings.push(`write: ${advisory.length} advisory finding(s) (unresolved, kept)`);
  const blocksFinal = finalUnits.filter((u) => !u.quiz).length;
  ctx.log(`s3.write: written=${unitsWritten} final_blocks=${blocksFinal} quiz=${quizItems.length} findings=${outcome.counts.findings} deleted=${deleted.length} guard_flagged=${records.length}`);
  return {
    outputs,
    metrics: {
      calls,
      units_written: unitsWritten,
      blocks_final: blocksFinal,
      quiz_final: quizItems.length,
      findings: outcome.counts.findings,
      revised: outcome.counts.revised,
      declined: outcome.counts.declined,
      unanswered: outcome.counts.unanswered,
      rounds: outcome.counts.rounds,
      disputed: finalUnits.filter((u) => statusOf(u.id) === "disputed").length,
      deleted_copied_phrase: deleted.length,
      removed_by_author: removedByAuthor.length,
      dropped_no_basis: droppedNoBasis.length,
      guard_flagged_units: records.length,
      guard_rewritten_units: records.filter((r) => r.rewritten).length,
      guard_dropped_sentences: records.reduce((n, r) => n + r.dropped_sentences.length, 0),
      guard_dropped_units: records.filter((r) => r.dropped_unit).length,
      advisory: advisory.length,
    },
    warnings,
  };
}
