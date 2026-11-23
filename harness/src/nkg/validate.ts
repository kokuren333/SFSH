/**
 * NKG validator (WP-1.1). errors block (schema / reference / build breakage, P-1-1(c));
 * warnings are §2.4 soft limits and never block (P-1).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { computeConfidence, type TieredSource } from "./confidence.ts";
import { evaluatePublic } from "./publicRules.ts";
import { buildNkgSchema } from "./schemaSource.ts";
import type { Grade, Nkg, NkgEdge, NkgNode, ProvenanceItem } from "./types.ts";

export interface ElementReport {
  grade: Grade;
  public_eligible: boolean;
  reasons: string[];
}

export interface NkgValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  elements: Record<string, ElementReport>;
}

/** Soft limits of §2.4 (all [暫定]; warnings only). */
export const SOFT_LIMITS = {
  label: 40,
  summary: 160,
  analysis: 400,
  Character: 30,
  Why: 20,
  whyDepth: 4,
  Secret: 12,
  motivesPerCharacter: 4,
  Arc: 8,
  WorldRule: 20,
  Setup: 8,
  Theme: 6,
  emotionBeatsPerPhase: 3,
  Context: 12,
  IconicMoment: 5,
  Quiz: 10,
  eventsPerUnit: 8,
  eventsTotal: 60,
} as const;

let compiled: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
    compiled = ajv.compile(buildNkgSchema());
  }
  return compiled;
}

/** Structural check only (ajv). */
export function validateNkgStructure(nkg: unknown): string[] {
  const fn = schemaValidator();
  if (fn(nkg)) return [];
  return (fn.errors ?? []).map((e) => `schema: ${e.instancePath || "/"} ${e.message ?? e.keyword}${e.params ? " " + JSON.stringify(e.params) : ""}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validateNkg(input: unknown): NkgValidation {
  const errors: string[] = validateNkgStructure(input);
  const warnings: string[] = [];
  const elements: Record<string, ElementReport> = {};

  // If the top-level shape is unusable, stop at structural errors.
  if (!isObj(input) || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || !Array.isArray(input.sources) || !isObj(input.work)) {
    return { ok: false, errors: errors.length ? errors : ["schema: top-level shape invalid"], warnings, elements };
  }
  const nkg = input as unknown as Nkg;
  const nodes = (nkg.nodes as unknown[]).filter(isObj) as unknown as NkgNode[];
  const edges = (nkg.edges as unknown[]).filter(isObj) as unknown as NkgEdge[];
  const sources = (nkg.sources as unknown[]).filter(isObj) as unknown as TieredSource[];
  const phases = Array.isArray(nkg.work.phases) ? nkg.work.phases : [];

  const sourceById = new Map(sources.map((s) => [s.source_id, s] as const));
  const phaseIds = new Set(phases.map((p) => p?.id));
  const nodeById = new Map<string, NkgNode>();
  const allIds = new Set<string>();

  // duplicate ids (nodes + edges share one namespace)
  for (const el of [...nodes, ...edges]) {
    if (typeof el.id !== "string") continue;
    if (allIds.has(el.id)) errors.push(`duplicate id ${el.id}`);
    allIds.add(el.id);
  }
  for (const n of nodes) if (typeof n.id === "string" && !nodeById.has(n.id)) nodeById.set(n.id, n);
  if (new Set(sources.map((s) => s.source_id)).size !== sources.length) errors.push("duplicate source_id in sources");
  if (new Set(phases.map((p) => p?.id)).size !== phases.length) errors.push("duplicate phase id");

  const nodeRef = (owner: string, field: string, id: unknown, wantType?: string | string[]) => {
    if (typeof id !== "string") return;
    const n = nodeById.get(id);
    if (!n) {
      errors.push(`dangling ref ${owner}.${field} → ${id}`);
      return;
    }
    const want = wantType === undefined ? null : Array.isArray(wantType) ? wantType : [wantType];
    if (want && !want.includes(n.type)) errors.push(`ref ${owner}.${field} → ${id} must be ${want.join("|")}, got ${n.type}`);
  };
  const phaseRef = (owner: string, field: string, id: unknown) => {
    if (id === null || id === undefined) return;
    if (typeof id === "string" && !phaseIds.has(id)) errors.push(`dangling phase ${owner}.${field} → ${id}`);
  };
  const provRefs = (owner: string, prov: ProvenanceItem[] | undefined) => {
    for (const p of prov ?? []) if (p && typeof p.source_id === "string" && !sourceById.has(p.source_id)) errors.push(`dangling source ${owner}.provenance → ${p.source_id}`);
  };

  const checkMeta = (owner: string, el: NkgNode | NkgEdge) => {
    const m = el.meta;
    if (!isObj(m)) return;
    provRefs(owner, m.provenance);
    phaseRef(owner, "meta.phase_ref", m.phase_ref);
    if (m.authored_by && m.authored_by === m.reviewed_by) errors.push(`${owner}: authored_by === reviewed_by (${m.authored_by})`);
    if (Array.isArray(m.provenance) && isObj(m.confidence)) {
      const re = computeConfidence(m.provenance, sourceById, m.review);
      if (re.grade !== m.confidence.grade || Math.abs(re.score - m.confidence.score) > 1e-9) {
        errors.push(`${owner}: stored confidence ${m.confidence.grade}/${m.confidence.score} ≠ recomputed ${re.grade}/${re.score}`);
      } else if (re.basis !== m.confidence.basis) {
        warnings.push(`${owner}: confidence basis text differs from recomputed ("${re.basis}")`);
      }
    }
  };

  const lenWarn = (owner: string, field: string, v: unknown, max: number) => {
    if (typeof v === "string" && [...v].length > max) warnings.push(`soft: ${owner}.${field} ${[...v].length} chars > ${max}`);
  };

  for (const n of nodes) {
    const o = `${n.type ?? "?"}:${n.id ?? "?"}`;
    checkMeta(o, n);
    for (const b of n.based_on ?? []) nodeRef(o, "based_on", b);
    lenWarn(o, "label", n.label, SOFT_LIMITS.label);
    lenWarn(o, "summary", n.summary, SOFT_LIMITS.summary);
    lenWarn(o, "analysis", n.analysis, SOFT_LIMITS.analysis);
    switch (n.type) {
      case "Event":
        phaseRef(o, "disclosure_phase", n.disclosure_phase);
        break;
      case "Motive":
        nodeRef(o, "owner", n.owner, "Character");
        phaseRef(o, "phase_from", n.phase_from);
        phaseRef(o, "phase_to", n.phase_to);
        break;
      case "Arc":
        nodeRef(o, "character", n.character, "Character");
        break;
      case "EmotionBeat":
        phaseRef(o, "phase", n.phase);
        for (const r of n.cause_refs ?? []) nodeRef(o, "cause_refs", r);
        break;
      case "IconicMoment":
        nodeRef(o, "event_ref", n.event_ref, "Event");
        for (const r of n.context_refs ?? []) nodeRef(o, "context_refs", r, "Context");
        break;
      case "Interpretation":
        for (const [i, p] of (n.positions ?? []).entries()) provRefs(`${o}.positions[${i}]`, p?.provenance);
        break;
      case "Quiz":
        for (const r of n.reasoning_refs ?? []) nodeRef(o, "reasoning_refs", r);
        break;
    }
  }

  for (const e of edges) {
    const o = `${e.type ?? "?"}:${e.id ?? "?"}`;
    checkMeta(o, e);
    const fromSpecial = e.type === "Knows" && e.from === "audience";
    const toSpecial = e.type === "About" && e.to === "work";
    if (!fromSpecial) nodeRef(o, "from", e.from);
    if (!toSpecial) nodeRef(o, "to", e.to);
    switch (e.type) {
      case "Relation":
        phaseRef(o, "phase_from", e.phase_from);
        phaseRef(o, "phase_to", e.phase_to);
        if (e.changed_by !== null && e.changed_by !== undefined) nodeRef(o, "changed_by", e.changed_by, "Event");
        break;
      case "Knows":
        phaseRef(o, "phase", e.phase);
        if (e.holder !== e.from) errors.push(`${o}: holder must equal from`);
        if (!fromSpecial) nodeRef(o, "holder", e.holder, "Character");
        nodeRef(o, "to", e.to, "Secret");
        break;
      case "Explains":
        for (const r of e.refs ?? []) nodeRef(o, "refs", r);
        break;
    }
  }

  // ---- §2.4 soft limits (warnings only) ----
  const count = (t: string) => nodes.filter((n) => n.type === t).length;
  for (const t of ["Character", "Why", "Secret", "Arc", "WorldRule", "Setup", "Theme", "Context", "IconicMoment", "Quiz"] as const) {
    const c = count(t);
    if (c > SOFT_LIMITS[t]) warnings.push(`soft: ${t} count ${c} > ${SOFT_LIMITS[t]}`);
  }
  const motivesByOwner = new Map<string, number>();
  for (const n of nodes) if (n.type === "Motive") motivesByOwner.set(n.owner, (motivesByOwner.get(n.owner) ?? 0) + 1);
  for (const [owner, c] of motivesByOwner) if (c > SOFT_LIMITS.motivesPerCharacter) warnings.push(`soft: Motive count for ${owner} ${c} > ${SOFT_LIMITS.motivesPerCharacter}`);
  const beatsByPhase = new Map<string, number>();
  for (const n of nodes) if (n.type === "EmotionBeat") beatsByPhase.set(n.phase, (beatsByPhase.get(n.phase) ?? 0) + 1);
  for (const [ph, c] of beatsByPhase) if (c > SOFT_LIMITS.emotionBeatsPerPhase) warnings.push(`soft: EmotionBeat count in ${ph} ${c} > ${SOFT_LIMITS.emotionBeatsPerPhase}`);

  const depth = whyDepth(nodes, edges);
  if (depth > SOFT_LIMITS.whyDepth) warnings.push(`soft: Why tree depth ${depth} > ${SOFT_LIMITS.whyDepth}`);

  const events = nodes.filter((n) => n.type === "Event");
  const units = coverageUnits(nkg);
  if (events.length > SOFT_LIMITS.eventsPerUnit * units) warnings.push(`soft: Event count ${events.length} > ${SOFT_LIMITS.eventsPerUnit} per coverage unit × ${units}`);
  if (events.length > SOFT_LIMITS.eventsTotal) warnings.push(`soft: Event count ${events.length} > ${SOFT_LIMITS.eventsTotal} total`);
  const byCov = new Map<string, number>();
  for (const ev of events) if (ev.meta?.coverage_ref) byCov.set(ev.meta.coverage_ref, (byCov.get(ev.meta.coverage_ref) ?? 0) + 1);
  if (byCov.size >= 2) for (const [cov, c] of byCov) if (c > SOFT_LIMITS.eventsPerUnit) warnings.push(`soft: Event count in coverage "${cov}" ${c} > ${SOFT_LIMITS.eventsPerUnit}`);

  // ---- per-element grade / public eligibility ----
  try {
    const usable = (el: NkgNode | NkgEdge) => isObj(el.meta) && isObj(el.meta.confidence) && Array.isArray(el.meta.provenance) && typeof el.id === "string";
    const okNodes = nodes.filter(usable).map((n) => ({ ...n, based_on: Array.isArray(n.based_on) ? n.based_on : [] }));
    const okEdges = edges.filter(usable);
    const elig = evaluatePublic(okNodes, okEdges);
    for (const el of [...okNodes, ...okEdges]) {
      const e = elig.get(el.id);
      elements[el.id] = { grade: el.meta.confidence.grade, public_eligible: e?.eligible ?? false, reasons: e?.reasons ?? [] };
    }
  } catch (err) {
    errors.push(`public rule evaluation failed: ${(err as Error).message}`);
  }

  return { ok: errors.length === 0, errors, warnings, elements };
}

function coverageUnits(nkg: Nkg): number {
  const cov = Array.isArray(nkg.work?.coverage) ? nkg.work.coverage : [];
  let units = 0;
  for (const c of cov) {
    if (c && typeof c.from === "number" && typeof c.to === "number" && c.to >= c.from) units += c.to - c.from + 1;
    else units += 1;
  }
  return Math.max(units, 1);
}

/** Longest Explains chain (in Why nodes) ending at an Outcome. Cycle-safe. */
export function whyDepth(nodes: NkgNode[], edges: NkgEdge[]): number {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type] as const));
  const children = new Map<string, string[]>(); // target → explaining whys
  for (const e of edges) {
    if (e.type !== "Explains") continue;
    if (!children.has(e.to)) children.set(e.to, []);
    children.get(e.to)!.push(e.from);
  }
  const memo = new Map<string, number>();
  const walk = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    let best = 0;
    for (const c of children.get(id) ?? []) if (typeOf.get(c) === "Why") best = Math.max(best, 1 + walk(c, stack));
    stack.delete(id);
    memo.set(id, best);
    return best;
  };
  let max = 0;
  for (const n of nodes) if (n.type === "Outcome") max = Math.max(max, walk(n.id, new Set()));
  return max;
}

/** Validate and write <workDir>/nkg/validation.json. Returns the validation and the relative path written. */
export function writeValidation(workDir: string, nkg: unknown, now: Date = new Date()): { validation: NkgValidation; output: string } {
  const validation = validateNkg(nkg);
  const rel = path.posix.join("nkg", "validation.json");
  const abs = path.join(workDir, "nkg", "validation.json");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ validated_at: now.toISOString(), schema_version: "1.0", ...validation }, null, 2) + "\n", "utf8");
  return { validation, output: rel };
}

/** Convenience: read <workDir>/nkg/nkg.json, validate, write validation.json. */
export function validateNkgFile(workDir: string, now?: Date): NkgValidation {
  const nkg = JSON.parse(readFileSync(path.join(workDir, "nkg", "nkg.json"), "utf8"));
  return writeValidation(workDir, nkg, now).validation;
}
