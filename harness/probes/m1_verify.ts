// M1 gate: independent re-verification of a work's NKG (orchestrator). usage: npx tsx harness/probes/m1_verify.ts <work_id>
import fs from "node:fs";
import path from "node:path";
import { validateNkg } from "../src/nkg/validate.ts";
import { computeConfidence } from "../src/nkg/confidence.ts";
import { assertCardsTraceable } from "../src/research/search.ts";
import { normKey, windows, hasVerbatimRun } from "../src/research/textMatch.ts";
const workId = process.argv[2];
const W = path.join("works", workId);
const nkg = JSON.parse(fs.readFileSync(path.join(W, "nkg", "nkg.json"), "utf8"));
const sources = JSON.parse(fs.readFileSync(path.join(W, "research", "sources.json"), "utf8"));
const claims = JSON.parse(fs.readFileSync(path.join(W, "research", "claims.json"), "utf8"));
const v = validateNkg(nkg);
const els = [...nkg.nodes, ...nkg.edges];
const byId = new Map(nkg.sources.map((s: any) => [s.source_id, s]));
let confMismatch = 0, noProv = 0, sameAuthor = 0, provNotCard = 0;
const cardIds = new Set(sources.map((s: any) => s.source_id));
for (const e of els) {
  if (!e.meta?.provenance?.length) noProv++;
  if (e.meta.authored_by === e.meta.reviewed_by) sameAuthor++;
  for (const p of e.meta.provenance) if (!cardIds.has(p.source_id)) provNotCard++;
  const c = computeConfidence(e.meta.provenance, byId as any, e.meta.review);
  if (c.grade !== e.meta.confidence.grade || c.score !== e.meta.confidence.score) confMismatch++;
}
const grades: Record<string, number> = {}; const epi: Record<string, number> = {}; const types: Record<string, number> = {}; const review: Record<string, number> = {};
for (const e of els) { grades[e.meta.confidence.grade] = (grades[e.meta.confidence.grade] ?? 0) + 1; epi[e.meta.epistemic] = (epi[e.meta.epistemic] ?? 0) + 1; types[e.type] = (types[e.type] ?? 0) + 1; review[e.meta.review] = (review[e.meta.review] ?? 0) + 1; }
// C-2 own check: any NKG text field sharing a ≥30-char normalized run with any saved source text
const win = new Set<string>();
for (const s of sources) { const t = fs.readFileSync(path.join(W, s.raw_text_path), "utf8"); for (const w of windows(normKey(t), 30)) win.add(w); }
const texts: string[] = [];
const walk = (o: any, k = "") => { if (typeof o === "string") { if (!["id","type","from","to","source_id","locator","module","phase_ref","coverage_ref","grade","basis","epistemic","spoiler","authored_by","reviewed_by","review","support"].includes(k)) texts.push(o); } else if (Array.isArray(o)) o.forEach((x) => walk(x, k)); else if (o && typeof o === "object") for (const [kk, vv] of Object.entries(o)) if (kk !== "sources" && kk !== "meta") walk(vv, kk); };
walk({ nodes: nkg.nodes, edges: nkg.edges, work: nkg.work });
const verbatim = texts.filter((t) => hasVerbatimRun(t, win, 30));
const quoteMarks = texts.filter((t) => /「[^」]{20,}」/.test(t));
const out = {
  work_id: workId, validateNkg_ok: v.ok, errors: v.errors.length, warnings: v.warnings.length,
  nodes: nkg.nodes.length, edges: nkg.edges.length, phases: nkg.work.phases.map((p: any) => p.label),
  elements_without_provenance: noProv, provenance_not_a_source_card: provNotCard, authored_eq_reviewed: sameAuthor, confidence_mismatch_recomputed: confMismatch,
  grades, epistemic: epi, review, types,
  gaps: nkg.gaps, module_selection: nkg.work.module_selection.map((m: any) => `${m.module}:${m.enabled ? "on" : "off"}`),
  public_eligible: Object.values(v.elements).filter((x: any) => x.public_eligible).length,
  sources: sources.length, source_tiers: sources.reduce((a: any, s: any) => ((a[s.tier] = (a[s.tier] ?? 0) + 1), a), {}),
  claims_active: claims.filter((c: any) => c.status === "active").length, claims_dropped: claims.filter((c: any) => c.status === "dropped").map((c: any) => c.drop_reason),
  traceability_violations: assertCardsTraceable(W),
  c2_text_fields_checked: texts.length, c2_verbatim_30_hits: verbatim, c2_long_bracket_quotes: quoteMarks,
  excerpt_max_chars: Math.max(...sources.map((s: any) => s.excerpts.reduce((n: number, e: any) => n + e.text.length, 0))),
};
console.log(JSON.stringify(out, null, 1));
