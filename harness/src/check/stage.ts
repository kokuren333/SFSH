/**
 * S4 automatic check stage (REQUIREMENTS §5.1 / §5.2, logs/m3/PLAN.md). Deterministic code + at most one
 * rewrite call per authoring model.
 *
 *  1. gen/public.json → check/public.before.json (verbatim copy, internal)
 *  2. A-2(a): media stripped from every string except sources[].url
 *  3. A-1: detect (≥ 30 normalized chars shared with saved source text, allowlist removed) → one rewrite call per
 *     authoring model (Haiku / Luna) with all its flagged strings → re-detect → still-flagged sentences removed
 *     (field rules + cascade in fix.ts) → repeat until nothing is flagged (after 5 rounds whole fields are emptied)
 *  4. re-scan A-2 / A-1 → residual (always 0 at the end); checkPublicWork() must be [] (else: implementation bug → throw)
 *  5. gen/public.json rewritten atomically (only when changed); advisory; check/report.json; notice
 * Never throws for detections, advisories or model failures (P-1).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PublicWork } from "../../../site/src/public-types.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { checkPublicWork } from "../gen/check.ts";
import { GEN_FILES, loadGenreVocab, loadTagVocab } from "../gen/io.ts";
import { S3_TIMEOUT_MS } from "../gen/tags.ts";
import { readJson, writeJson } from "../nkg/io.ts";
import type { Nkg } from "../nkg/types.ts";
import { readWork, writeWork } from "../works/store.ts";
import type { Work } from "../works/types.ts";
import { A1_REWRITE_SCHEMA, a1RewritePrompt, buildA1Index, buildAllowlist, flaggedSpans, makeReducer, readSourceCorpus, roleOf, type A1Index, type Reducer, type RewriteItem, type SourceCorpus } from "./a1.ts";
import { stripMedia } from "./a2.ts";
import { computeAdvisory, countAdvisory } from "./advisory.ts";
import { applyEdits, type LeafEdit } from "./fix.ts";
import { authorIndex, authorOf, charCount, elementIdOf, fmtPath, inA1Scope, inA2Scope, lastKey, removeSpans, setAt, sha16, stringLeaves, type AuthorIndex, type Seg, type Span } from "./leaves.ts";
import { buildNotice } from "./notice.ts";
import { A1_RUN, CHECK_FILES, LONG_QUOTE_CHARS, SIMILARITY, type A1Detected, type A2Detected, type Author, type AuthorBasis, type CascadeEntry, type CheckReport, type RemovedEntry, type RewriteStat } from "./types.ts";

export const S4_TIMEOUT_MS = S3_TIMEOUT_MS;
/** Removal rounds that drop single sentences; later rounds empty the whole field (residual must end at 0). */
const SENTENCE_ROUNDS = 5;
const MAX_ROUNDS = 10;

interface Inputs {
  pw: PublicWork;
  nkg: Nkg | null;
  work: Partial<Work> | null;
  corpus: SourceCorpus;
  reducer: Reducer;
  index: A1Index;
  authors: AuthorIndex;
  allowlist: string[];
}

function readWorkOrNull(workDir: string): Partial<Work> | null {
  try {
    return existsSync(path.join(workDir, "work.json")) ? readWork(workDir) : null;
  } catch {
    return null;
  }
}

function readNkgOrNull(workDir: string): Nkg | null {
  try {
    return readJson<Nkg | null>(workDir, "nkg/nkg.json", null);
  } catch {
    return null;
  }
}

function prepare(workDir: string, pw: PublicWork): Inputs {
  const nkg = readNkgOrNull(workDir);
  const work = readWorkOrNull(workDir);
  const allowlist = buildAllowlist(pw, work, nkg);
  const reducer = makeReducer(allowlist);
  const corpus = readSourceCorpus(workDir);
  return { pw, nkg, work, corpus, reducer, index: buildA1Index(corpus, reducer, A1_RUN), authors: authorIndex(nkg), allowlist };
}

// ------------------------------------------------------------------ A-1 / A-2 primitives (pure on a PublicWork)
export interface A1Item {
  path: Seg[];
  value: string;
  spans: Span[];
  element_id: string | null;
  author: Author;
  basis: AuthorBasis;
}

export function detectA1(pw: PublicWork, index: A1Index, authors: AuthorIndex): { items: A1Item[]; scanned: number } {
  const items: A1Item[] = [];
  let scanned = 0;
  for (const l of stringLeaves(pw)) {
    if (!inA1Scope(l.path) || !l.value.trim()) continue;
    scanned++;
    const spans = flaggedSpans(l.value, index);
    if (!spans.length) continue;
    const a = authorOf(pw, l.path, authors);
    items.push({ path: l.path, value: l.value, spans, element_id: a.element_id, author: a.author, basis: a.basis });
  }
  return { items, scanned };
}

/** Strip media from every A-2 string of `pw` in place. */
export function stripA2(pw: PublicWork): { detected: A2Detected[]; fieldActions: RemovedEntry[]; cascade: CascadeEntry[]; warnings: string[] } {
  const detected: A2Detected[] = [];
  const edits: LeafEdit[] = [];
  for (const l of stringLeaves(pw)) {
    if (!inA2Scope(l.path)) continue;
    const r = stripMedia(l.value);
    if (!r.hits.length) continue;
    for (const h of r.hits) detected.push({ path: fmtPath(l.path), kind: h.kind, sha256: h.sha256 });
    edits.push({ path: l.path, value: r.out, origHash: sha16(l.value), element_id: elementIdOf(pw, l.path) });
  }
  if (!edits.length) return { detected, fieldActions: [], cascade: [], warnings: [] };
  const oc = applyEdits(pw, edits);
  return { detected, fieldActions: oc.fieldActions, cascade: oc.cascade, warnings: oc.warnings };
}

function countA2(pw: PublicWork): number {
  let n = 0;
  for (const l of stringLeaves(pw)) if (inA2Scope(l.path)) n += stripMedia(l.value).hits.length;
  return n;
}

function countA1(pw: PublicWork, index: A1Index, authors: AuthorIndex): number {
  return detectA1(pw, index, authors).items.reduce((n, it) => n + it.spans.length, 0);
}

/**
 * Pure re-check of works/<id>/gen/public.json (no model calls, no writes): the number of A-1 flagged sentences and
 * A-2 media matches left in the public file. Used for reproducibility comparisons (7.3) and after S4 (both 0).
 */
export function recheckPublic(workDir: string): { a1_residual: number; a2_residual: number } {
  const pw = JSON.parse(readFileSync(path.join(workDir, GEN_FILES.public), "utf8")) as PublicWork;
  const inp = prepare(workDir, pw);
  return { a1_residual: countA1(pw, inp.index, inp.authors), a2_residual: countA2(pw) };
}

function vocabLabels(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    for (const v of [...loadGenreVocab(), ...loadTagVocab()]) m.set(v.slug, v.label);
  } catch {
    /* vocab is optional for the advisory */
  }
  return m;
}

// ------------------------------------------------------------------ stage
export async function autoCheck(ctx: StageContext): Promise<StageResult> {
  const pubAbs = path.join(ctx.workDir, GEN_FILES.public);
  if (!existsSync(pubAbs)) throw new Error(`S4 autocheck: ${GEN_FILES.public} missing — run compose first`);
  const beforeText = readFileSync(pubAbs, "utf8");
  const pw = JSON.parse(beforeText) as PublicWork;
  const beforeCanon = JSON.stringify(pw);
  mkdirSync(path.join(ctx.workDir, "check"), { recursive: true });
  writeFileSync(path.join(ctx.workDir, CHECK_FILES.before), beforeText, "utf8");
  const outputs: string[] = [CHECK_FILES.before];
  const warnings: string[] = [];
  const hadMatrix = pw.work.has_matrix;

  // 2) A-2(a)
  const a2 = stripA2(pw);
  warnings.push(...a2.warnings);

  // 3) A-1
  const inp = prepare(ctx.workDir, pw);
  if (inp.corpus.missing.length) warnings.push(`check: raw text missing for ${inp.corpus.missing.length} source(s) (excerpts still checked): ${inp.corpus.missing.join(", ")}`);
  const first = detectA1(pw, inp.index, inp.authors);
  const detected: A1Detected[] = first.items.flatMap((it) =>
    it.spans.map((sp) => ({ path: fmtPath(it.path), element_id: it.element_id, author: it.author, author_basis: it.basis, sentence_sha256: sha16(sp.text), chars: charCount(sp.text) })),
  );
  const rewrite: Record<Author, RewriteStat> = { haiku: { calls: 0, items: 0, failed: false }, luna: { calls: 0, items: 0, failed: false } };
  const rewrittenPaths: Seg[][] = [];
  let modelCalls = 0;
  for (const author of ["haiku", "luna"] as const) {
    const its = first.items.filter((i) => i.author === author);
    if (!its.length) continue;
    const req: RewriteItem[] = its.map((it, n) => ({ id: `i${String(n + 1).padStart(2, "0")}`, path: fmtPath(it.path), role: roleOf(lastKey(it.path)), text: it.value, flagged: it.spans.map((s) => s.text) }));
    rewrite[author].calls = 1;
    rewrite[author].items = its.length;
    modelCalls++;
    try {
      const port = author === "haiku" ? ctx.haiku : ctx.luna;
      const r = await port.call({ task: "s4.a1.rewrite", prompt: a1RewritePrompt({ title: pw.work.title, items: req }), schema: A1_REWRITE_SCHEMA, tools: "none", jobId: ctx.jobId, timeoutMs: S4_TIMEOUT_MS });
      const got = (r.output as { items?: unknown } | null)?.items;
      const byId = new Map<string, string>();
      for (const x of Array.isArray(got) ? got : []) {
        const o = x as { id?: unknown; text?: unknown };
        if (typeof o?.id === "string" && typeof o.text === "string" && !byId.has(o.id)) byId.set(o.id, o.text);
      }
      req.forEach((q, n) => {
        const text = byId.get(q.id)?.trim();
        if (!text || text === its[n].value) return;
        // a rewrite must not bring media in: strip it (counted as A-2 detections)
        const m = stripMedia(text);
        for (const h of m.hits) a2.detected.push({ path: q.path, kind: h.kind, sha256: h.sha256 });
        if (!m.out.trim()) return;
        setAt(pw, its[n].path, m.out);
        rewrittenPaths.push(its[n].path);
      });
    } catch (e) {
      rewrite[author].failed = true;
      warnings.push(`check: ${author} rewrite call failed (${(e as Error).message.slice(0, 160)}) — flagged sentences are removed`);
    }
  }
  const afterRewrite = new Set(detectA1(pw, inp.index, inp.authors).items.map((it) => fmtPath(it.path)));
  const rewrittenOk = rewrittenPaths.filter((p) => !afterRewrite.has(fmtPath(p))).length;

  const removed: RemovedEntry[] = [];
  const cascade: CascadeEntry[] = [];
  const removeFlagged = () => {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { items } = detectA1(pw, inp.index, inp.authors);
      if (!items.length) break;
      const edits: LeafEdit[] = items.map((it) => {
        for (const sp of it.spans) removed.push({ path: fmtPath(it.path), element_id: it.element_id, action: "sentence_removed", sentence_sha256: sha16(sp.text) });
        return { path: it.path, value: round < SENTENCE_ROUNDS ? removeSpans(it.value, it.spans) : "", origHash: sha16(it.value), element_id: it.element_id };
      });
      const oc = applyEdits(pw, edits);
      removed.push(...oc.fieldActions);
      cascade.push(...oc.cascade);
      warnings.push(...oc.warnings);
    }
  };
  removeFlagged();

  // 4) re-scan (A-2 again — a removal never adds media, but keep the loop closed — then A-1 again)
  for (let k = 0; k < 3; k++) {
    const again = stripA2(pw);
    if (!again.detected.length) break;
    a2.detected.push(...again.detected);
    a2.fieldActions.push(...again.fieldActions);
    a2.cascade.push(...again.cascade);
    removeFlagged();
  }
  const a1Residual = countA1(pw, inp.index, inp.authors);
  const a2Residual = countA2(pw);
  const shape = checkPublicWork(pw);
  if (shape.length) throw new Error(`S4 autocheck: fixed public.json breaks the PublicWork shape (implementation bug): ${shape.slice(0, 6).join("; ")}`);
  if (a1Residual || a2Residual) throw new Error(`S4 autocheck: residual after fix A-1=${a1Residual} A-2=${a2Residual} (implementation bug)`);

  // 5) write
  const changed = JSON.stringify(pw) !== beforeCanon;
  if (changed) outputs.push(writeJson(ctx.workDir, GEN_FILES.public, pw));
  if (hadMatrix !== pw.work.has_matrix && existsSync(path.join(ctx.workDir, "work.json"))) {
    try {
      const w = readWork(ctx.workDir);
      w.has_matrix = pw.work.has_matrix;
      writeWork(ctx.workDir, w);
      outputs.push("work.json");
    } catch (e) {
      warnings.push(`check: work.json has_matrix not updated (${(e as Error).message.slice(0, 120)})`);
    }
  }

  const advisory = computeAdvisory({ workDir: ctx.workDir, pw, work: inp.work, nkg: inp.nkg, corpus: inp.corpus, reducer: inp.reducer, vocabLabels: vocabLabels() });
  const advisoryCounts = countAdvisory(advisory);
  const reportBase = {
    a1: {
      threshold: A1_RUN,
      sources_checked: inp.corpus.checked,
      sources_missing: inp.corpus.missing,
      allowlist_terms: inp.allowlist.length,
      texts_scanned: first.scanned,
      detected,
      rewrite,
      rewritten_ok: rewrittenOk,
      removed,
      cascade_removed: cascade,
      residual_after_fix: a1Residual,
    },
    a2: { detected: a2.detected, removed: a2.detected.length, residual_after_fix: a2Residual, field_actions: a2.fieldActions, cascade_removed: a2.cascade },
    advisory_counts: advisoryCounts,
  };
  const report: CheckReport = {
    schema: "sfsh-check/1",
    work_id: pw.work.work_id || ctx.workId,
    job_id: ctx.jobId,
    checked_at: ctx.now().toISOString(),
    blocking: false,
    a1: reportBase.a1,
    a2: reportBase.a2,
    advisory,
    advisory_counts: advisoryCounts,
    params: { a1_run: A1_RUN, long_quote_chars: LONG_QUOTE_CHARS, similarity: { ...SIMILARITY } },
    notice: buildNotice(reportBase),
  };
  outputs.push(writeJson(ctx.workDir, CHECK_FILES.report, report));

  const sentencesRemoved = removed.filter((r) => r.action === "sentence_removed").length;
  const advTotal = advisory.length;
  if (detected.length || a2.detected.length) warnings.push(`check: A-1 detected ${detected.length} (rewritten ${rewrittenOk}, sentences removed ${sentencesRemoved}), A-2 detected ${a2.detected.length} — fixed in gen/public.json`);
  if (advTotal) warnings.push(`check: advisory ${advTotal} (${Object.entries(advisoryCounts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(", ")})`);
  ctx.log(`s4.autocheck: a1=${detected.length} rewritten=${rewrittenOk} removed=${sentencesRemoved} a2=${a2.detected.length} residual=${a1Residual + a2Residual} advisory=${advTotal}`);
  const metrics: Record<string, number | string> = {
    calls: modelCalls,
    a1_detected: detected.length,
    a1_rewritten: rewrittenOk,
    a1_removed: sentencesRemoved,
    a1_elements_removed: removed.filter((r) => r.action === "element_removed").length,
    a1_cascade: cascade.length,
    a2_detected: a2.detected.length,
    a2_removed: a2.detected.length,
    residual: a1Residual + a2Residual,
    advisory: advTotal,
    public_changed: changed ? 1 : 0,
  };
  for (const [t, n] of Object.entries(advisoryCounts)) metrics[`adv_${t}`] = n;
  return { outputs, metrics, warnings };
}

/** Stage descriptor for the job runner (orchestrator): S4 runs after `compose`, job state `checking`. */
export const AUTOCHECK_STAGE = { name: "autocheck", state: "checking", run: autoCheck } as const;
