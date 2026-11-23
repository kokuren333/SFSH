/**
 * AMENDMENT 11 (BRIEF §14, 2026-11-23 12:51): the long spoiler synopsis 「あらすじ（全編・ネタバレ）」 — a new S3
 * page type written in the write stage (in parallel with the other pages; `sfsh regen --parts synopsis` re-writes
 * only this page).
 *
 * Material: the public projection's fact layer (events in story order with the causal chain, characters, relations,
 * motives, arcs, world rules, setups, emotion beats, secrets, outcomes — `analysis` fields and the essay-page items
 * are left out) plus the work's active canon claims (no excerpts). No search / fetch.
 *
 *  1. Haiku: chapter plan + intro (one call).
 *  2. Haiku: one call per chapter, in parallel (≤ CHAPTER_CONCURRENCY at a time).
 *  3. Luna reviews all synopsis blocks (findings only), Haiku revises — max REVIEW_MAX_ROUNDS rounds.
 *  4. Unresolved copied_phrase → block deleted (C-2); the 30-char guard against saved source text (one rewrite, then
 *     sentence drop); based_on kept only for fact-layer public ids, blocks without any basis dropped (C-7).
 *  5. Volume / paragraph / interpretive-word measurement → gen/synopsis_report.json (advisory only, nothing cut).
 * Outputs (internal): gen/pages/synopsis.json, gen/reviews/synopsis.json, gen/synopsis_report.json.
 */
import type { PlotNode, PublicWork } from "../../../site/src/public-types.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { readActiveClaims, readJson, writeJson } from "../nkg/io.ts";
import { FINDINGS_SCHEMA, REVIEW_MAX_ROUNDS, advisoryFrom, completedResponses, copiedPhraseTargets, runReviewLoop, type FindingResponse, type RawFinding } from "../nkg/review.ts";
import type { Epistemic, ReviewState } from "../nkg/types.ts";
import type { Claim } from "../research/claimTypes.ts";
import { GEN_FILES, maxSpoiler } from "./io.ts";
import { citableIds } from "./project.ts";
import { REWRITE_SCHEMA, WRITE_REVISION_SCHEMA, type ReviewUnitView } from "./prompts.ts";
import {
  MAX_SYNOPSIS_CHAPTERS,
  MAX_SYNOPSIS_SECTIONS,
  SYNOPSIS_CHAPTER_SCHEMA,
  SYNOPSIS_INTERPRETIVE_PATTERNS,
  SYNOPSIS_PLAN_SCHEMA,
  SYNOPSIS_SPEC,
  synopsisChapterPrompt,
  synopsisPlanPrompt,
  synopsisReviewPrompt,
  synopsisRevisePrompt,
  synopsisRewritePrompt,
  synopsisStylePrompt,
  type SynopsisPlanChapter,
} from "./synopsisPrompts.ts";
import { S3_TIMEOUT_MS } from "./tags.ts";
import {
  applyVerbatimGuard,
  applyWriteRevision,
  asEpi,
  asSpoiler,
  chars,
  ids,
  paras,
  str,
  unitText,
  unresolvedOf,
  VERBATIM_THRESHOLD,
  type GuardRecord,
  type InternalBlock,
  type PageFile,
  type Unit,
} from "./write.ts";

/** Parallel chapter calls per work (3 works run in parallel → at most 3× this many CLI processes). */
export const CHAPTER_CONCURRENCY = 6;
/** Claim aspects that are not story facts (bibliographic data, titles, genre labels, reception). */
const NON_STORY_ASPECTS = new Set(["bibliographic", "title", "genre", "M12"]);

/** Overall character target by the scale of the work (BRIEF: 8,000–15,000, longer works thicker). */
export function synopsisTarget(pw: PublicWork): readonly [number, number] {
  const eps = Number((pw.work.coverage_label.match(/全\s*(\d+)\s*話/) ?? [])[1] ?? NaN);
  if (pw.work.medium === "film") return [8000, 10000];
  if (Number.isFinite(eps)) return eps <= 13 ? [9000, 12000] : eps <= 26 ? [11000, 14000] : [12000, 15000];
  if (pw.work.medium === "novel" || pw.work.medium === "manga" || pw.work.medium === "game") return [9000, 12000];
  return [8000, 12000];
}

/** Active canon claims about the story (no bibliographic / title / genre / reception-only claims). */
export function synopsisClaims(workDir: string): Claim[] {
  return readActiveClaims(workDir).filter((c) => c.epistemic === "canon" && (c.aspects ?? []).some((a) => !NON_STORY_ASPECTS.has(a)));
}

/**
 * Fact-layer material for the synopsis: public elements without `analysis` (interpretation layer) and without the
 * essay-page items (themes / context / interpretations). Returns the prompt JSON and the ids citable by the synopsis.
 */
export function synopsisMaterial(pw: PublicWork, claims: Claim[]): { json: string; factIds: Set<string> } {
  const name = new Map(pw.viz.relations.characters.map((c) => [c.id, c.label] as const));
  const n = (id: string) => name.get(id) ?? id;
  const ev = [...pw.elements.events].sort((a, b) => (a.story_order ?? 1e9) - (b.story_order ?? 1e9));
  const outcomes = pw.viz.reverse_plot.trees.map((t: PlotNode) => ({
    id: t.id,
    label: t.label,
    summary: t.summary,
    direct_causes: t.children.filter((c) => c.level === "direct").map((c) => ({ id: c.id, label: c.label, summary: c.summary })),
  }));
  const factIds = new Set<string>();
  const add = (...xs: { id: string }[]) => xs.forEach((x) => factIds.add(x.id));
  add(...ev, ...pw.viz.relations.characters, ...pw.viz.relations.relations, ...pw.elements.motives, ...pw.elements.arcs, ...pw.elements.world_rules, ...pw.elements.setups, ...pw.elements.emotion_beats, ...(pw.viz.matrix?.secrets ?? []));
  for (const t of pw.viz.reverse_plot.trees) {
    factIds.add(t.id);
    for (const c of t.children) if (c.level === "direct") factIds.add(c.id);
  }
  const json = JSON.stringify({
    work: { title: pw.work.title, medium: pw.work.medium, coverage: pw.work.coverage_label, creators: pw.work.creators.map((c) => c.name) },
    phases: pw.phases,
    events: ev.map((e) => ({ id: e.id, story_order: e.story_order, phase: e.phase_ref, label: e.label, summary: e.summary, caused_by: e.caused_by, leads_to: e.leads_to, spoiler: e.spoiler })),
    characters: pw.viz.relations.characters.map((c) => ({ id: c.id, name: c.label, summary: c.summary, faction: c.faction })),
    factions: pw.viz.relations.factions,
    relations: pw.viz.relations.relations.map((r) => ({ id: r.id, from: n(r.from), to: n(r.to), kind: r.kind, valence: r.valence, phase_from: r.phase_from, phase_to: r.phase_to, changed_by: r.changed_by_label })),
    motives: pw.elements.motives.map((m) => ({ id: m.id, owner: n(m.owner), kind: m.kind, label: m.label, summary: m.summary, phase_from: m.phase_from, phase_to: m.phase_to, drives: m.drives })),
    arcs: pw.elements.arcs.map((a) => ({ id: a.id, character: n(a.character), label: a.label, initial_state: a.initial_state, final_state: a.final_state, summary: a.summary, turns_at: a.turns_at })),
    world_rules: pw.elements.world_rules.map((w) => ({ id: w.id, kind: w.kind, label: w.label, summary: w.summary, consequence: w.consequence })),
    setups: pw.elements.setups.map((s) => ({ id: s.id, label: s.label, meaning: s.meaning, pays_off: s.pays_off })),
    emotion_beats: pw.elements.emotion_beats.map((b) => ({ id: b.id, phase: b.phase, label: b.label, summary: b.summary, evoked_by: b.evoked_by })),
    secrets: (pw.viz.matrix?.secrets ?? []).map((s) => ({ id: s.id, label: s.label })),
    outcomes,
    claims: claims.map((c) => ({ id: c.claim_id, phase_hint: c.phase_hint, spoiler: c.spoiler, text: c.text })),
  });
  return { json, factIds };
}

/**
 * One chapter's own material: its assigned events (full fields) plus the elements linked to them (motives that drive
 * them, arcs that turn at them, rules that constrain them, relations changed by them or starting in its phases,
 * setups paid off by them, emotion beats evoked by them or in its phases) and its assigned claims.
 */
export function chapterFocus(pw: PublicWork, claims: Claim[], ch: SynopsisPlanChapter): string {
  const evIds = new Set(ch.event_ids);
  const name = new Map(pw.viz.relations.characters.map((c) => [c.id, c.label] as const));
  const n = (id: string) => name.get(id) ?? id;
  const el = pw.elements;
  const events = el.events.filter((e) => evIds.has(e.id));
  const labels = new Set(events.map((e) => e.label));
  const phases = new Set([...ch.phase_ids, ...events.map((e) => e.phase_ref).filter((x): x is string => !!x)]);
  const claimIds = new Set(ch.claim_ids);
  return JSON.stringify({
    events: events.map((e) => ({ id: e.id, story_order: e.story_order, phase: e.phase_ref, label: e.label, summary: e.summary, caused_by: e.caused_by, leads_to: e.leads_to })),
    motives: el.motives.filter((m) => m.drives.some((d) => evIds.has(d))).map((m) => ({ id: m.id, owner: n(m.owner), kind: m.kind, label: m.label, summary: m.summary })),
    arcs: el.arcs.filter((a) => a.turns_at.some((t) => evIds.has(t))).map((a) => ({ id: a.id, character: n(a.character), label: a.label, initial_state: a.initial_state, final_state: a.final_state, summary: a.summary })),
    world_rules: el.world_rules.filter((w) => w.constrains.some((c) => evIds.has(c))).map((w) => ({ id: w.id, label: w.label, summary: w.summary, consequence: w.consequence })),
    relations: pw.viz.relations.relations.filter((r) => (r.changed_by_label && labels.has(r.changed_by_label)) || (r.phase_from && phases.has(r.phase_from))).map((r) => ({ id: r.id, from: n(r.from), to: n(r.to), kind: r.kind, changed_by: r.changed_by_label })),
    setups: el.setups.filter((x) => x.pays_off.some((p) => evIds.has(p))).map((x) => ({ id: x.id, label: x.label, meaning: x.meaning })),
    emotion_beats: el.emotion_beats.filter((b) => b.evoked_by.some((e) => evIds.has(e)) || phases.has(b.phase)).map((b) => ({ id: b.id, label: b.label, summary: b.summary })),
    claims: claims.filter((c) => claimIds.has(c.claim_id)).map((c) => ({ id: c.claim_id, text: c.text })),
  });
}

/** Share of sentences in です・ます style (sentence ends; closing brackets ignored). 1 when there is no sentence. */
export function politeRatio(paragraphs: string[]): number {
  const ends = paragraphs.flatMap((p) => p.split(/[。！？]/).map((x) => x.trim().replace(/[」』）)]+$/, "")).filter(Boolean));
  if (!ends.length) return 1;
  return ends.filter((e) => /(ます|ました|ません|ませんでした|です|でした|でしょう|ましょう)$/.test(e)).length / ends.length;
}
/** Below this share a block gets the style-only conversion. */
export const POLITE_MIN = 0.8;

/** Plan output → chapters (empty / headless chapters dropped, capped). */
export function planFrom(out: unknown): { intro: { paragraphs: string[]; based_on: string[] } | null; chapters: SynopsisPlanChapter[] } {
  const o = (out ?? {}) as Record<string, unknown>;
  const i = (o.intro ?? {}) as Record<string, unknown>;
  const intro = paras(i.paragraphs).length ? { paragraphs: paras(i.paragraphs), based_on: ids(i.based_on) } : null;
  const chapters: SynopsisPlanChapter[] = [];
  for (const c of (Array.isArray(o.chapters) ? o.chapters : []) as Record<string, unknown>[]) {
    if (chapters.length >= MAX_SYNOPSIS_CHAPTERS) break;
    const heading = str(c?.heading);
    if (!heading) continue;
    const t = Number(c.target_chars);
    chapters.push({
      heading,
      phase_ids: ids(c.phase_ids),
      event_ids: ids(c.event_ids),
      claim_ids: ids(c.claim_ids),
      introduces: ids(c.introduces),
      gist: str(c.gist),
      target_chars: Number.isFinite(t) ? Math.min(SYNOPSIS_SPEC.chapterChars[1], Math.max(SYNOPSIS_SPEC.chapterChars[0], t)) : 1000,
    });
  }
  return { intro, chapters };
}

const cid = (k: number) => `syn_c${String(k + 1).padStart(2, "0")}`;

/** Chapter outputs → units: syn_intro, syn_c01_s01, ... (ids fixed by code). */
export function synopsisUnits(plan: ReturnType<typeof planFrom>, chapterOuts: unknown[]): Unit[] {
  const units: Unit[] = [];
  if (plan.intro) units.push({ id: "syn_intro", page: "synopsis", slot: "synopsis", heading: null, paragraphs: plan.intro.paragraphs, quiz: null, based_on: plan.intro.based_on, spoiler: "ending", epistemic: "canon" });
  plan.chapters.forEach((_, k) => {
    const secs = (((chapterOuts[k] ?? {}) as Record<string, unknown>).sections ?? []) as Record<string, unknown>[];
    let s = 0;
    for (const b of Array.isArray(secs) ? secs : []) {
      if (s >= MAX_SYNOPSIS_SECTIONS) break;
      const p = paras(b?.paragraphs);
      if (!p.length) continue;
      units.push({ id: `${cid(k)}_s${String(s + 1).padStart(2, "0")}`, page: "synopsis", slot: "synopsis", heading: str(b.heading) || null, paragraphs: p, quiz: null, based_on: ids(b.based_on), spoiler: asSpoiler(b.spoiler), epistemic: asEpi(b.epistemic) });
      s++;
    }
  });
  return units;
}

export interface SynopsisChapterMeasure {
  id: string;
  heading: string;
  sections: number;
  paragraphs: number;
  chars: number;
}
export interface SynopsisReport {
  generated_at: string;
  spec: typeof SYNOPSIS_SPEC;
  target: readonly [number, number];
  material: { events: number; characters: number; claims: number; material_json_chars: number };
  plan_chapters: number;
  units_written: number;
  intro_chars: number;
  chapters: SynopsisChapterMeasure[];
  /** Characters of the synopsis (intro + chapter headings + section headings + paragraphs). */
  total_chars: number;
  paragraphs: number;
  avg_paragraph_chars: number;
  long_paragraphs: { id: string; index: number; chars: number }[];
  chapters_below: string[];
  chapters_above: string[];
  below_target: boolean;
  above_target: boolean;
  /** Interpretation / evaluation words found (fact-layer prose should have none; advisory). */
  interpretive_words: { id: string; word: string }[];
  /** です・ます: blocks converted by the style pass, and blocks still below POLITE_MIN at the end (advisory). */
  style_fixed: number;
  style_plain_blocks: string[];
  removed_by_author: string[];
  deleted_copied_phrase: string[];
  dropped_no_basis: string[];
  based_on_filtered: { id: string; removed: string[] }[];
  guard: { sources_checked: number; sources_missing: string[]; threshold: number; records: GuardRecord[] };
  warnings: string[];
}

async function pool<T, R>(xs: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

export async function writeSynopsis(ctx: StageContext): Promise<StageResult> {
  const pw = readJson<PublicWork | null>(ctx.workDir, GEN_FILES.projection, null);
  if (!pw) throw new Error(`S3 synopsis: ${GEN_FILES.projection} missing — run projectPublic first`);
  const title = pw.work.title;
  const claims = synopsisClaims(ctx.workDir);
  const { json: material, factIds } = synopsisMaterial(pw, claims);
  const cite = citableIds(pw);
  const target = synopsisTarget(pw);
  const warnings: string[] = [];
  let calls = 0;

  // 1) plan + intro
  const planOut = await ctx.haiku.call({ task: "s3.synopsis.plan", prompt: synopsisPlanPrompt({ title, material, target }), schema: SYNOPSIS_PLAN_SCHEMA, jobId: ctx.jobId, timeoutMs: S3_TIMEOUT_MS });
  calls++;
  const plan = planFrom(planOut.output);
  if (!plan.chapters.length) throw new Error("S3 synopsis: the plan has no chapters");
  if (plan.chapters.length < SYNOPSIS_SPEC.chapters[0]) warnings.push(`synopsis: ${plan.chapters.length} chapter(s) planned (target ${SYNOPSIS_SPEC.chapters[0]}–${SYNOPSIS_SPEC.chapters[1]}; advisory)`);
  ctx.log(`s3.synopsis: plan chapters=${plan.chapters.length} target_sum=${plan.chapters.reduce((n, c) => n + c.target_chars, 0)} target=${target.join("-")}`);

  // 2) chapters in parallel
  const introText = plan.intro?.paragraphs.join("\n") ?? "";
  const chapterOuts = await pool(plan.chapters, CHAPTER_CONCURRENCY, async (_c, k) => {
    const introducedBefore = plan.chapters.slice(0, k).flatMap((c) => c.introduces);
    try {
      const r = await ctx.haiku.call({
        task: "s3.synopsis.chapter",
        prompt: synopsisChapterPrompt({ title, material, intro: introText, plan: plan.chapters, index: k, introducedBefore, focus: chapterFocus(pw, claims, plan.chapters[k]!) }),
        schema: SYNOPSIS_CHAPTER_SCHEMA,
        jobId: ctx.jobId,
        timeoutMs: S3_TIMEOUT_MS,
      });
      return r.output;
    } catch (e) {
      warnings.push(`synopsis: chapter ${k + 1} call failed (${(e as Error).message.slice(0, 160)}) — chapter left out`);
      return null;
    } finally {
      calls++;
    }
  });
  const written = synopsisUnits(plan, chapterOuts);
  if (!written.some((u) => u.id !== "syn_intro")) throw new Error("S3 synopsis: no chapter text was written");
  const unitsWritten = written.length;

  // 2b) one style (です・ます) pass for blocks written in plain style — before the review, so Luna reviews the final text
  const plain = written.filter((u) => politeRatio(u.paragraphs) < POLITE_MIN);
  let styleFixed = 0;
  if (plain.length) {
    try {
      const r = await ctx.haiku.call({ task: "s3.synopsis.style", prompt: synopsisStylePrompt({ title, units: plain.map((u) => ({ id: u.id, text: u.paragraphs.join("\n") })) }), schema: REWRITE_SCHEMA, jobId: ctx.jobId, timeoutMs: S3_TIMEOUT_MS });
      const got = new Map(((r.output as { units?: Record<string, unknown>[] }).units ?? []).map((x) => [str(x?.id), paras(x?.paragraphs)] as const));
      for (const u of written) {
        const p = got.get(u.id);
        if (p && p.length && plain.includes(u)) {
          u.paragraphs = p;
          styleFixed++;
        }
      }
    } catch (e) {
      warnings.push(`synopsis: style call failed (${(e as Error).message.slice(0, 160)}) — plain-style blocks kept`);
    } finally {
      calls++;
    }
  }
  const chapterHeading = (id: string) => {
    const m = id.match(/^syn_c(\d+)_/);
    return m ? plan.chapters[Number(m[1]) - 1]?.heading ?? "" : "";
  };
  const viewOf = (u: Unit): ReviewUnitView => {
    const m = u.id.match(/^syn_c(\d+)_/);
    return { id: u.id, page: m ? `synopsis/第${Number(m[1])}章「${chapterHeading(u.id)}」` : "synopsis/導入", text: unitText(u), based_on: u.based_on, spoiler: u.spoiler, epistemic: u.epistemic };
  };

  // 3) Luna review (findings only), Haiku revises — max 2 rounds
  const removedByAuthor: string[] = [];
  const outcome = await runReviewLoop<Unit[]>({
    initial: written,
    maxRounds: REVIEW_MAX_ROUNDS,
    ids: (s) => s.map((u) => u.id),
    review: async (state, round, prior) => {
      if (!state.length) return [];
      const r = await ctx.luna.call({
        task: "s3.synopsis.review",
        prompt: synopsisReviewPrompt({ title, units: state.map(viewOf), material, claims, prior, round, maxRounds: REVIEW_MAX_ROUNDS }),
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
        task: "s3.synopsis.revise",
        prompt: synopsisRevisePrompt({ title, units: state.map(viewOf), findings, material, round, maxRounds: REVIEW_MAX_ROUNDS }),
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

  // 4) 30-char guard (synopsis rewrite prompt), then based_on → fact-layer public ids only (C-7)
  const guarded = await applyVerbatimGuard(ctx, title, units, warnings, { task: "s3.synopsis.rewrite", prompt: (us) => synopsisRewritePrompt({ title, units: us }) });
  calls += guarded.calls;
  units = guarded.units;
  const basedOnFiltered: SynopsisReport["based_on_filtered"] = [];
  const droppedNoBasis: string[] = [];
  const finalUnits: Unit[] = [];
  for (const u of units) {
    const kept = u.based_on.filter((id) => factIds.has(id) && cite.has(id));
    const removed = u.based_on.filter((id) => !kept.includes(id));
    if (removed.length) basedOnFiltered.push({ id: u.id, removed });
    if (!kept.length) {
      droppedNoBasis.push(u.id);
      continue;
    }
    finalUnits.push({ ...u, based_on: kept });
  }

  // 5) blocks, chapters, measurement
  const now = ctx.now().toISOString();
  const statusOf = (id: string): ReviewState => outcome.status[id] ?? "agreed";
  const spoilerOf = (u: Unit) => maxSpoiler(u.spoiler, ...u.based_on.map((id) => cite.get(id)?.spoiler));
  const epistemicOf = (u: Unit): Epistemic => (u.epistemic === "canon" && u.based_on.every((id) => cite.get(id)?.epistemic === "canon") ? "canon" : "sfsh_analysis");
  const blocks: InternalBlock[] = finalUnits.map((u) => ({
    id: u.id,
    heading: u.heading,
    paragraphs: u.paragraphs,
    spoiler: spoilerOf(u),
    based_on: u.based_on,
    epistemic: epistemicOf(u),
    slot: "synopsis",
    authored_by: "haiku",
    reviewed_by: "luna",
    review: statusOf(u.id),
  }));
  const chapters = plan.chapters
    .map((c, k) => ({ id: cid(k), heading: c.heading, block_ids: blocks.filter((b) => b.id.startsWith(`${cid(k)}_`)).map((b) => b.id) }))
    .filter((c) => c.block_ids.length);
  const introIds = blocks.filter((b) => b.id === "syn_intro").map((b) => b.id);
  const file: PageFile = { page: "synopsis", generated_at: now, blocks, intro_ids: introIds, chapters };
  const outputs: string[] = [writeJson(ctx.workDir, GEN_FILES.page("synopsis"), file)];

  const unitChars = (u: Unit) => u.paragraphs.reduce((m, x) => m + chars(x), 0) + (u.heading ? chars(u.heading) : 0);
  const chapterMeasures: SynopsisChapterMeasure[] = chapters.map((c) => {
    const us = finalUnits.filter((u) => c.block_ids.includes(u.id));
    return { id: c.id, heading: c.heading, sections: us.length, paragraphs: us.reduce((n, u) => n + u.paragraphs.length, 0), chars: chars(c.heading) + us.reduce((n, u) => n + unitChars(u), 0) };
  });
  const introChars = finalUnits.filter((u) => u.id === "syn_intro").reduce((n, u) => n + unitChars(u), 0);
  const total = introChars + chapterMeasures.reduce((n, c) => n + c.chars, 0);
  const allParas = finalUnits.flatMap((u) => u.paragraphs.map((p, i) => ({ id: u.id, index: i, chars: chars(p) })));
  const interpretive: SynopsisReport["interpretive_words"] = [];
  for (const u of finalUnits) for (const w of SYNOPSIS_INTERPRETIVE_PATTERNS) if ([u.heading ?? "", ...u.paragraphs].join("").includes(w)) interpretive.push({ id: u.id, word: w });
  const report: SynopsisReport = {
    generated_at: now,
    spec: SYNOPSIS_SPEC,
    target,
    material: { events: pw.elements.events.length, characters: pw.viz.relations.characters.length, claims: claims.length, material_json_chars: material.length },
    plan_chapters: plan.chapters.length,
    units_written: unitsWritten,
    intro_chars: introChars,
    chapters: chapterMeasures,
    total_chars: total,
    paragraphs: allParas.length,
    avg_paragraph_chars: allParas.length ? Math.round((allParas.reduce((n, p) => n + p.chars, 0) / allParas.length) * 10) / 10 : 0,
    long_paragraphs: allParas.filter((p) => p.chars > SYNOPSIS_SPEC.paragraphMax),
    chapters_below: chapterMeasures.filter((c) => c.chars < SYNOPSIS_SPEC.chapterChars[0]).map((c) => c.id),
    chapters_above: chapterMeasures.filter((c) => c.chars > SYNOPSIS_SPEC.chapterChars[1]).map((c) => c.id),
    below_target: total < target[0],
    above_target: total > target[1],
    interpretive_words: interpretive,
    style_fixed: styleFixed,
    style_plain_blocks: finalUnits.filter((u) => politeRatio(u.paragraphs) < POLITE_MIN).map((u) => u.id),
    removed_by_author: removedByAuthor,
    deleted_copied_phrase: deleted,
    dropped_no_basis: droppedNoBasis,
    based_on_filtered: basedOnFiltered,
    guard: { sources_checked: guarded.src.checked, sources_missing: guarded.src.missing, threshold: VERBATIM_THRESHOLD, records: guarded.records },
    warnings,
  };
  if (report.below_target) warnings.push(`synopsis: ${total} chars, below the target ${target[0]}–${target[1]} (advisory, kept — material-bound)`);
  if (report.long_paragraphs.length) warnings.push(`synopsis: ${report.long_paragraphs.length} paragraph(s) over ${SYNOPSIS_SPEC.paragraphMax} chars (advisory, kept)`);
  if (interpretive.length) warnings.push(`synopsis: interpretive words in ${new Set(interpretive.map((x) => x.id)).size} block(s) (advisory, kept)`);
  if (deleted.length) warnings.push(`synopsis: ${deleted.length} block(s) deleted for unresolved copied_phrase: ${deleted.join(", ")}`);
  if (droppedNoBasis.length) warnings.push(`synopsis: ${droppedNoBasis.length} block(s) dropped (no fact-layer basis): ${droppedNoBasis.join(", ")}`);
  if (advisory.length) warnings.push(`synopsis: ${advisory.length} advisory finding(s) (unresolved, kept)`);

  outputs.push(
    writeJson(ctx.workDir, GEN_FILES.reviewSynopsis, {
      layer: "synopsis",
      author: "haiku",
      reviewer: "luna",
      max_rounds: REVIEW_MAX_ROUNDS,
      rounds: outcome.rounds.map((r) => ({ round: r.round, findings: r.findings, responses: completedResponses(r) })),
      counts: outcome.counts,
      status: outcome.status,
      status_counts: Object.entries(outcome.status)
        .filter(([id]) => !deleted.includes(id))
        .reduce((m, [, s]) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), { agreed: 0, revised: 0, disputed: 0 } as Record<string, number>),
      unresolved,
      deleted: deleted.map((id) => ({ id, reason: "copied_phrase" })),
      advisory,
    }),
  );
  outputs.push(writeJson(ctx.workDir, GEN_FILES.synopsisReport, report));
  ctx.log(`s3.synopsis: chapters=${chapters.length} blocks=${blocks.length} chars=${total} findings=${outcome.counts.findings} deleted=${deleted.length} guard_flagged=${guarded.records.length}`);
  return {
    outputs,
    metrics: {
      synopsis_calls: calls,
      synopsis_chapters: chapters.length,
      synopsis_blocks: blocks.length,
      synopsis_chars: total,
      synopsis_intro_chars: introChars,
      synopsis_findings: outcome.counts.findings,
      synopsis_revised: outcome.counts.revised,
      synopsis_rounds: outcome.counts.rounds,
      synopsis_disputed: blocks.filter((b) => b.review === "disputed").length,
      synopsis_deleted_copied_phrase: deleted.length,
      synopsis_dropped_no_basis: droppedNoBasis.length,
      synopsis_guard_flagged_units: guarded.records.length,
      synopsis_guard_dropped_sentences: guarded.records.reduce((n, r) => n + r.dropped_sentences.length, 0),
      synopsis_long_paragraphs: report.long_paragraphs.length,
      synopsis_interpretive_words: interpretive.length,
      synopsis_advisory: advisory.length,
      synopsis_style_fixed: styleFixed,
      synopsis_style_plain_blocks: report.style_plain_blocks.length,
    },
    warnings,
  };
}
