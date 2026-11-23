// M6 (CP-052) WP-6.1/6.2: 7.3 reproducibility items + content figures of works whose S2–S4 ran inside ONE job
// (unlike m3_repro.ts, S4 is NOT re-applied here: each run's own check/ is read as it is).
// usage: node harness/probes/m6_repro.ts <out.json> <label>=<root>:<work_id>:<job_id> ...
//   <root> = a repository root (main repo or a worktree) holding works/<work_id>/ and logs/jobs/<job_id>.state.json.
import fs from "node:fs";
import path from "node:path";
import { recheckPublic } from "../src/check/index.ts";
import { computeConfidence } from "../src/nkg/confidence.ts";
import { validateNkg } from "../src/nkg/validate.ts";
import { computeChainDropout } from "../src/gen/project.ts";
import { assertCardsTraceable } from "../src/research/search.ts";

const [outFile, ...specs] = process.argv.slice(2);
if (!outFile || !specs.length) throw new Error("usage: m6_repro.ts <out.json> <label>=<root>:<work_id>:<job_id> ...");
const readJ = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const rows: Record<string, unknown>[] = [];
for (const spec of specs) {
  const m = /^([^=]+)=(.+):([^:]+):([^:]+)$/.exec(spec);
  if (!m) throw new Error(`bad spec ${spec}`);
  const [, label, root, workId, jobId] = m as unknown as [string, string, string, string, string];
  const W = path.join(root, "works", workId);
  const nkg = readJ(path.join(W, "nkg", "nkg.json"));
  const sources = readJ(path.join(W, "research", "sources.json"));
  const cardIds = new Set(sources.map((s: { source_id: string }) => s.source_id));
  const byId = new Map(nkg.sources.map((s: { source_id: string }) => [s.source_id, s]));
  const v = validateNkg(nkg);
  let noProv = 0, provNotCard = 0, sameNkg = 0, confMismatch = 0;
  for (const e of [...nkg.nodes, ...nkg.edges]) {
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
  const recheck = recheckPublic(W);
  const report = readJ(path.join(W, "check", "report.json"));
  const proj = readJ(path.join(W, "gen", "projection.json"));
  const pub = readJ(path.join(W, "gen", "public.json"));
  const state = readJ(path.join(root, "logs", "jobs", `${jobId}.state.json`));
  const sec = (s: string) => Math.round((state.stages[s]?.duration_ms ?? 0) / 1000);
  const cd = proj.chain_dropout ?? computeChainDropout(nkg, v as never);
  rows.push({
    run: label,
    work_id: workId,
    gate: {
      validation_ok: v.ok,
      validation_errors: v.errors.length,
      elements_without_provenance: noProv,
      provenance_not_a_source_card: provNotCard,
      authored_eq_reviewed: { nkg: sameNkg, claims_active: sameClaims, pages: !pagesRev.author || pagesRev.author === pagesRev.reviewer ? 1 : 0, tags: tags.authored_by && tags.reviewed_by ? (tags.authored_by === tags.reviewed_by ? 1 : 0) : "absent" },
      confidence_recompute_mismatch: confMismatch,
      traceability_violations: assertCardsTraceable(W).length,
      a1_residual_after_s4: recheck.a1_residual,
      a2_residual_after_s4: recheck.a2_residual,
    },
    content: {
      nodes: nkg.nodes.length,
      edges: nkg.edges.length,
      phases: nkg.work.phases.map((p: { label: string }) => p.label),
      gaps: nkg.gaps.map((g: { module: string }) => g.module),
      validation_warnings: v.warnings.length,
      public_eligible: Object.values(v.elements).filter((x) => (x as { public_eligible: boolean }).public_eligible).length,
      public_included: state.stages.project?.metrics?.elements_included ?? null,
      chain_dropout: { count: cd.count, by_type: cd.by_type, top_roots: (cd.roots ?? []).slice(0, 3).map((r: { root_id: string; root_type: string; dependents: number }) => `${r.root_id}(${r.root_type}) ${r.dependents}`) },
      characters: pub.viz.relations.characters.length,
      relations: pub.viz.relations.relations.length,
      matrix_secrets: pub.viz.matrix?.secrets.length ?? 0,
      s4: { a1_detected: report.a1.detected.length, a1_removed: report.a1.removed.length, a2_detected: report.a2.detected.length, advisory: report.advisory_counts },
      stage_sec: Object.fromEntries(["modules", "phases", "fact", "interp", "tags", "project", "write", "compose", "autocheck"].map((s) => [s, sec(s)])),
      s2_s4_sec: ["modules", "phases", "fact", "interp", "assemble", "check", "tags", "project", "write", "compose", "autocheck"].reduce((a, s) => a + sec(s), 0),
      attempts: Object.fromEntries(Object.entries(state.stages).filter(([, r]) => (r as { attempts: number }).attempts > 1).map(([k, r]) => [k, (r as { attempts: number }).attempts])),
    },
  });
}
const keys = (o: unknown, pre = ""): [string, unknown][] =>
  o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, pre ? `${pre}.${k}` : k)) : [[pre, o]];
const gateRows = rows.map((r) => new Map(keys(r.gate)));
const identical = [...gateRows[0]!.keys()].every((k) => gateRows.every((g) => JSON.stringify(g.get(k)) === JSON.stringify(gateRows[0]!.get(k))));
const out = { compared_at: new Date().toISOString(), runs: rows, gate_items_identical: identical };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n", "utf8");
console.log(JSON.stringify(out, null, 1));
