// M3 gate 7.4 (v1.4) reproducibility: apply S4 to each saved S2–S3 run of one work and compare the 7.3 items.
// usage: node harness/probes/m3_repro.ts <work_id> <out.json> <runDir> [<runDir>...]
//   runDir holds nkg/, gen/, work.json (snapshot of works/<work_id>/ after `job resume --from modules --until compose`).
//   Research (saved claims + source cards + raw text) is taken from works/<work_id>/research — the same saved input for every run.
// Writes <runDir>/check/ (S4 output) and prints/writes the comparison. S4 uses the real model ports only if A-1 detects something.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autoCheck, recheckPublic } from "../src/check/index.ts";
import { getModelPort } from "../src/model/index.ts";
import { computeConfidence } from "../src/nkg/confidence.ts";
import { validateNkg } from "../src/nkg/validate.ts";
import { computeChainDropout } from "../src/gen/project.ts";
import { assertCardsTraceable } from "../src/research/search.ts";
import type { Fetcher } from "../src/research/types.ts";

const [workId, outFile, ...runDirs] = process.argv.slice(2);
if (!workId || !outFile || !runDirs.length) throw new Error("usage: m3_repro.ts <work_id> <out.json> <runDir>...");
const mainWork = path.join("works", workId);
const readJ = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const noFetcher: Fetcher = { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) };

const rows: Record<string, unknown>[] = [];
for (const runDir of runDirs) {
  const tmpWorks = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh_m3repro_"));
  const W = path.join(tmpWorks, workId);
  fs.cpSync(path.join(mainWork, "research"), path.join(W, "research"), { recursive: true });
  for (const sub of ["nkg", "gen"]) fs.cpSync(path.join(runDir, sub), path.join(W, sub), { recursive: true });
  fs.copyFileSync(path.join(runDir, "work.json"), path.join(W, "work.json"));

  const t0 = Date.now();
  const s4 = await autoCheck({
    jobId: `m3repro-${path.basename(runDir)}`, workDir: W, workId, range: [{ unit: "whole", from: null, to: null, label: "全体" }],
    luna: getModelPort("luna"), haiku: getModelPort("haiku"), fetcher: noFetcher,
    budget: { limits: { searches: 0, fetches: 0, wallMs: 0 }, searchesUsed: 0, fetchesUsed: 0, startedAt: new Date().toISOString() },
    now: () => new Date(), log: (m) => console.error(`[${path.basename(runDir)}] ${m}`),
  });
  const s4ms = Date.now() - t0;
  fs.rmSync(path.join(runDir, "check"), { recursive: true, force: true });
  fs.cpSync(path.join(W, "check"), path.join(runDir, "check"), { recursive: true });
  fs.copyFileSync(path.join(W, "gen", "public.json"), path.join(runDir, "check", "public.after.json"));

  const nkg = readJ(path.join(W, "nkg", "nkg.json"));
  const sources = readJ(path.join(W, "research", "sources.json"));
  const cardIds = new Set(sources.map((s: { source_id: string }) => s.source_id));
  const byId = new Map(nkg.sources.map((s: { source_id: string }) => [s.source_id, s]));
  const v = validateNkg(nkg);
  const els = [...nkg.nodes, ...nkg.edges];
  let noProv = 0, provNotCard = 0, sameNkg = 0, confMismatch = 0;
  for (const e of els) {
    if (!e.meta?.provenance?.length) noProv++;
    if (!e.meta?.authored_by || e.meta.authored_by === e.meta.reviewed_by) sameNkg++;
    for (const p of e.meta.provenance ?? []) if (!cardIds.has(p.source_id)) provNotCard++;
    const c = computeConfidence(e.meta.provenance, byId as never, e.meta.review);
    if (c.grade !== e.meta.confidence.grade || c.score !== e.meta.confidence.score) confMismatch++;
  }
  const claims = readJ(path.join(W, "research", "claims.json"));
  const sameClaims = claims.filter((c: { status: string; authored_by?: string; reviewed_by?: string | null }) => c.status === "active" && (!c.reviewed_by || c.authored_by === c.reviewed_by)).length;
  const pagesRev = readJ(path.join(W, "gen", "reviews", "pages.json"));
  const tags = readJ(path.join(W, "gen", "tags.json"));
  const samePages = !pagesRev.author || pagesRev.author === pagesRev.reviewer ? 1 : 0;
  const sameTags = tags.authored_by && tags.reviewed_by ? (tags.authored_by === tags.reviewed_by ? 1 : 0) : "absent (pre-CP-032 code at the pinned commit)";
  const recheck = recheckPublic(W);
  const report = readJ(path.join(W, "check", "report.json"));
  const proj = readJ(path.join(W, "gen", "projection.json"));
  const pub = readJ(path.join(W, "gen", "public.json"));
  const state = readJ(path.join(runDir, "state.json"));
  const sec = (s: string) => Math.round((state.stages[s]?.duration_ms ?? 0) / 1000);
  rows.push({
    run: path.basename(runDir),
    // ---- 7.3 reproducibility items (must be identical across runs)
    gate: {
      validation_ok: v.ok,
      validation_errors: v.errors.length,
      elements_without_provenance: noProv,
      provenance_not_a_source_card: provNotCard,
      authored_eq_reviewed: { nkg: sameNkg, claims_active: sameClaims, pages: samePages, tags: sameTags },
      confidence_recompute_mismatch: confMismatch,
      traceability_violations: assertCardsTraceable(W).length,
      a1_residual_after_s4: recheck.a1_residual,
      a2_residual_after_s4: recheck.a2_residual,
    },
    // ---- content (LLM variation allowed; reported as findings, not compared)
    content: {
      nodes: nkg.nodes.length, edges: nkg.edges.length, phases: nkg.work.phases.map((p: { label: string }) => p.label),
      gaps: nkg.gaps.map((g: { module: string }) => g.module), validation_warnings: v.warnings.length,
      public_eligible: Object.values(v.elements).filter((x) => (x as { public_eligible: boolean }).public_eligible).length,
      public_included: state.stages.project?.metrics?.elements_included ?? null,
      // computed here with the current code (the pinned-commit projection has no chain_dropout field)
      chain_dropout: (() => { const c = computeChainDropout(nkg, v as never); return { count: c.count, top_roots: c.roots.slice(0, 3).map((r) => `${r.root_id}(${r.root_type}) ${r.dependents}`) }; })(),
      characters: pub.viz.relations.characters.length, relations: pub.viz.relations.relations.length, matrix_secrets: pub.viz.matrix?.secrets.length ?? 0,
      s4: { a1_detected: report.a1.detected.length, a1_rewritten_ok: report.a1.rewritten_ok, a1_removed: report.a1.removed.length, a2_detected: report.a2.detected.length, advisory: report.advisory_counts, s4_ms: s4ms, calls: s4.metrics.calls },
      stage_sec: { modules: sec("modules"), phases: sec("phases"), fact: sec("fact"), interp: sec("interp"), tags: sec("tags"), write: sec("write") },
      interp_attempts: state.stages.interp?.attempts,
    },
  });
}
const keys = (o: unknown, pre = ""): [string, unknown][] =>
  o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, pre ? `${pre}.${k}` : k)) : [[pre, o]];
const gateRows = rows.map((r) => new Map(keys(r.gate)));
const allKeys = [...gateRows[0]!.keys()];
const identical = allKeys.every((k) => gateRows.every((g) => JSON.stringify(g.get(k)) === JSON.stringify(gateRows[0]!.get(k))));
const out = { work_id: workId, compared_at: new Date().toISOString(), runs: rows, gate_items_identical: identical };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n", "utf8");
console.log(JSON.stringify(out, null, 1));
