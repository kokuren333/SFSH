/**
 * S3 compose (deterministic): gen/projection.json + gen/pages/*.json (display fields only) → gen/public.json,
 * validated against the PublicWork shape and scanned for internal fields. Then updates work.json's catalog
 * fields and rebuilds works/INDEX.json, and writes gen/gen_check.json (counts, authorship check over NKG elements,
 * page units and gen/tags.json, drops, size).
 *
 * first_published_at / updated_at (M2 provisional, PLAN §2): first / last successful compose. M5 switches
 * them to publish times.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { PlotNode, PublicWork, QuizItem, TextBlock } from "../../../site/src/public-types.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { readJson, writeJson } from "../nkg/io.ts";
import type { Nkg } from "../nkg/types.ts";
import { readWork, rebuildIndex, writeWork } from "../works/store.ts";
import { checkPublicWork, forbiddenContent } from "./check.ts";
import { GEN_FILES, maxSpoiler, readFinalTags, type PageKey } from "./io.ts";
import { citableIds } from "./project.ts";
import type { PageFile, WriteReport } from "./write.ts";

function displayBlock(b: TextBlock, cite: Set<string>): TextBlock {
  return {
    id: b.id,
    heading: b.heading ?? null,
    paragraphs: [...(b.paragraphs ?? [])],
    spoiler: b.spoiler,
    based_on: (b.based_on ?? []).filter((id) => cite.has(id)),
    epistemic: b.epistemic,
  };
}
function displayQuiz(q: QuizItem, cite: Set<string>): QuizItem {
  return {
    id: q.id,
    quiz_type: q.quiz_type,
    question: q.question,
    answer: q.answer,
    explanation: q.explanation ?? "",
    based_on: (q.based_on ?? []).filter((id) => cite.has(id) && id !== q.id),
    spoiler: q.spoiler,
  };
}

export interface AuthorshipCheck {
  nkg_elements_checked: number;
  nkg_violations: number;
  page_units_checked: number;
  page_violations: number;
  /** 1 when gen/tags.json exists (CP-029 weak point a), else 0. */
  tags_checked: number;
  /** 1 when gen/tags.json lacks authored_by / reviewed_by or they are equal. */
  tags_violations: number;
  /** gen/tags.json authorship as recorded (null when the file or the field is absent). */
  tags_authored_by: string | null;
  tags_reviewed_by: string | null;
  violations_total: number;
  violation_ids: string[];
}

/** Authorship header of gen/tags.json (written by suggestTags). */
export interface TagsAuthorship {
  authored_by?: unknown;
  reviewed_by?: unknown;
}

/**
 * authored_by ≠ reviewed_by over every NKG element, every page block / quiz item and gen/tags.json (§3.2).
 * `tags` = parsed gen/tags.json, or null when the file does not exist (then nothing is checked for tags).
 */
export function authorshipCheck(nkg: Nkg | null, pages: (PageFile | null)[], tags: TagsAuthorship | null = null): AuthorshipCheck {
  const bad: string[] = [];
  let nChecked = 0;
  for (const el of [...(nkg?.nodes ?? []), ...(nkg?.edges ?? [])]) {
    nChecked++;
    const a = el.meta?.authored_by;
    const r = el.meta?.reviewed_by;
    if (!a || !r || a === r) bad.push(`nkg:${el.id}`);
  }
  const nkgBad = bad.length;
  let pChecked = 0;
  for (const p of pages) {
    for (const u of [...(p?.blocks ?? []), ...(p?.items ?? [])] as { id: string; authored_by?: string; reviewed_by?: string }[]) {
      pChecked++;
      if (!u.authored_by || !u.reviewed_by || u.authored_by === u.reviewed_by) bad.push(`page:${p!.page}:${u.id}`);
    }
  }
  const pageBad = bad.length - nkgBad;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const ta = tags ? str(tags.authored_by) : null;
  const tr = tags ? str(tags.reviewed_by) : null;
  const tagsBad = tags && (!ta || !tr || ta === tr) ? 1 : 0;
  if (tagsBad) bad.push("tags:gen/tags.json");
  return {
    nkg_elements_checked: nChecked,
    nkg_violations: nkgBad,
    page_units_checked: pChecked,
    page_violations: pageBad,
    tags_checked: tags ? 1 : 0,
    tags_violations: tagsBad,
    tags_authored_by: ta,
    tags_reviewed_by: tr,
    violations_total: bad.length,
    violation_ids: bad,
  };
}

/** Pure part of compose: projection + page files (+ tags / timestamps) → PublicWork. */
export function composePublicWork(
  projection: PublicWork,
  pages: Partial<Record<PageKey, PageFile | null>>,
  opts: { tags: string[] | null; first_published_at: string | null; updated_at: string | null },
): PublicWork {
  const cite = new Set(citableIds(projection).keys());
  const blocks = (page: PageKey, slot?: string) => (pages[page]?.blocks ?? []).filter((b) => !slot || b.slot === slot).map((b) => displayBlock(b, cite));
  const figureNote = (slot: "relations" | "reverse_plot" | "matrix", present: boolean) => (present ? (blocks("figure_notes", slot)[0] ?? null) : null);
  const quizPage = pages.quiz;
  const quiz = (quizPage ? (quizPage.items ?? []) : projection.pages.quiz).map((q) => displayQuiz(q, cite));

  const pw: PublicWork = {
    schema: "sfsh-public/1",
    work: { ...projection.work },
    phases: projection.phases,
    viz: projection.viz,
    pages: {
      overview: blocks("overview"),
      figure_notes: {
        relations: figureNote("relations", projection.viz.relations.characters.length > 0),
        reverse_plot: figureNote("reverse_plot", projection.viz.reverse_plot.trees.length > 0),
        matrix: figureNote("matrix", projection.viz.matrix !== null),
      },
      themes: { intro: blocks("themes", "intro"), items: projection.pages.themes.items },
      context: { intro: blocks("context", "intro"), items: projection.pages.context.items, iconic: projection.pages.context.iconic },
      interpretations: { intro: blocks("interpretations", "intro"), items: projection.pages.interpretations.items },
      quiz,
    },
    elements: projection.elements,
    gaps: projection.gaps,
    sources: projection.sources,
  };
  const textSpoilers = [
    ...pw.pages.overview,
    ...[pw.pages.figure_notes.relations, pw.pages.figure_notes.reverse_plot, pw.pages.figure_notes.matrix].filter((b): b is TextBlock => !!b),
    ...pw.pages.themes.intro,
    ...pw.pages.context.intro,
    ...pw.pages.interpretations.intro,
    ...pw.pages.quiz,
  ].map((b) => b.spoiler);
  pw.work.spoiler_max = maxSpoiler(projection.work.spoiler_max, ...textSpoilers);
  if (opts.tags) pw.work.tags = opts.tags;
  pw.work.first_published_at = opts.first_published_at;
  pw.work.updated_at = opts.updated_at;
  return pw;
}

export async function composePublic(ctx: StageContext): Promise<StageResult> {
  const projection = readJson<PublicWork | null>(ctx.workDir, GEN_FILES.projection, null);
  if (!projection) throw new Error(`S3 compose: ${GEN_FILES.projection} missing — run projectPublic first`);
  const pages: Partial<Record<PageKey, PageFile | null>> = {};
  for (const p of ["overview", "figure_notes", "themes", "context", "interpretations", "quiz"] as const) pages[p] = readJson<PageFile | null>(ctx.workDir, GEN_FILES.page(p), null);
  const warnings: string[] = [];
  if (!pages.overview) warnings.push("compose: gen/pages missing — public.json has no page text (run writePages)");

  const now = ctx.now().toISOString();
  const hasWork = existsSync(path.join(ctx.workDir, "work.json"));
  const work = hasWork ? readWork(ctx.workDir) : null;
  const tags = existsSync(path.join(ctx.workDir, GEN_FILES.tags)) ? readFinalTags(ctx.workDir) : null;
  const pw = composePublicWork(projection, pages, { tags, first_published_at: work?.first_published_at ?? now, updated_at: now });

  const shape = checkPublicWork(pw);
  const forbidden = forbiddenContent(pw);
  if (shape.length || forbidden.length) throw new Error(`S3 compose: public.json rejected: ${[...shape, ...forbidden].slice(0, 8).join("; ")}`);
  const outPublic = writeJson(ctx.workDir, GEN_FILES.public, pw);
  const bytes = Buffer.byteLength(JSON.stringify(pw, null, 2) + "\n", "utf8");

  const outputs = [outPublic];
  if (work) {
    work.genres = pw.work.genres;
    work.tags = pw.work.tags;
    work.status = pw.work.status;
    work.coverage_label = pw.work.coverage_label;
    work.spoiler_max = pw.work.spoiler_max;
    work.has_matrix = pw.work.has_matrix;
    work.first_published_at = pw.work.first_published_at;
    work.updated_at = pw.work.updated_at;
    writeWork(ctx.workDir, work);
    rebuildIndex(path.dirname(ctx.workDir));
    outputs.push("work.json");
  } else warnings.push("compose: work.json missing — ledger / INDEX not updated");

  // gen_check.json
  const nkg = readJson<Nkg | null>(ctx.workDir, "nkg/nkg.json", null);
  const tagsFile = readJson<TagsAuthorship | null>(ctx.workDir, GEN_FILES.tags, null);
  const auth = authorshipCheck(nkg, Object.values(pages), tagsFile && typeof tagsFile === "object" ? tagsFile : null);
  const report = readJson<WriteReport | null>(ctx.workDir, GEN_FILES.writeReport, null);
  const plotCount = (ns: PlotNode[]): number => ns.reduce((s, n) => s + 1 + plotCount(n.children), 0);
  const blocksCount = {
    overview: pw.pages.overview.length,
    figure_notes: [pw.pages.figure_notes.relations, pw.pages.figure_notes.reverse_plot, pw.pages.figure_notes.matrix].filter(Boolean).length,
    intros: pw.pages.themes.intro.length + pw.pages.context.intro.length + pw.pages.interpretations.intro.length,
    quiz: pw.pages.quiz.length,
  };
  const check = {
    generated_at: now,
    elements: {
      characters: pw.viz.relations.characters.length,
      relations: pw.viz.relations.relations.length,
      trees: pw.viz.reverse_plot.trees.length,
      plot_nodes: plotCount(pw.viz.reverse_plot.trees),
      matrix_secrets: pw.viz.matrix?.secrets.length ?? 0,
      matrix_holders: pw.viz.matrix?.holders.length ?? 0,
      matrix_cells: pw.viz.matrix?.cells.length ?? 0,
      timeline_events: pw.viz.timeline?.events.length ?? 0,
      themes: pw.pages.themes.items.length,
      contexts: pw.pages.context.items.length,
      iconic: pw.pages.context.iconic.length,
      interpretations: pw.pages.interpretations.items.length,
      factions: pw.viz.relations.factions.length,
      events: pw.elements.events.length,
      motives: pw.elements.motives.length,
      arcs: pw.elements.arcs.length,
      world_rules: pw.elements.world_rules.length,
      setups: pw.elements.setups.length,
      emotion_beats: pw.elements.emotion_beats.length,
      sources: pw.sources.length,
      gaps: pw.gaps.length,
    },
    blocks: blocksCount,
    authorship: auth,
    dropped: {
      removed_by_author: report?.removed_by_author.length ?? 0,
      deleted_copied_phrase: report?.deleted_copied_phrase.length ?? 0,
      dropped_no_basis: report?.dropped_no_basis.length ?? 0,
      guard_dropped_sentences: report?.guard.records.reduce((n, r) => n + r.dropped_sentences.length, 0) ?? 0,
      guard_dropped_units: report?.guard.records.filter((r) => r.dropped_unit).length ?? 0,
    },
    public_json_bytes: bytes,
    shape_problems: shape.length,
    forbidden_findings: forbidden.length,
  };
  outputs.push(writeJson(ctx.workDir, GEN_FILES.genCheck, check));
  if (auth.violations_total) warnings.push(`compose: authored_by = reviewed_by violations: ${auth.violations_total} (${auth.violation_ids.slice(0, 5).join(", ")})`);
  ctx.log(`s3.compose: bytes=${bytes} blocks=${blocksCount.overview}+${blocksCount.figure_notes}+${blocksCount.intros} quiz=${blocksCount.quiz} authorship_violations=${auth.violations_total}`);
  return {
    outputs,
    metrics: {
      public_bytes: bytes,
      overview_blocks: blocksCount.overview,
      figure_notes: blocksCount.figure_notes,
      intro_blocks: blocksCount.intros,
      quiz: blocksCount.quiz,
      sources: pw.sources.length,
      authorship_violations: auth.violations_total,
      spoiler_max: pw.work.spoiler_max,
      has_matrix: pw.work.has_matrix ? 1 : 0,
      tags: pw.work.tags.length,
    },
    warnings,
  };
}
