/**
 * Drafts → NKG elements (WP-1.5 assembly). Deterministic code only:
 *  - claim_refs → meta.provenance (source_id from the claim's source_ids, locator "claim:<id>", support "direct")
 *  - basis only via based_on → union of the basis nodes' provenance with support "inferred", epistemic sfsh_analysis
 *  - neither valid claim_refs nor valid based_on → rejected (C-7), logged, not put in the NKG
 *  - authored_by / reviewed_by (opposite model) / review from the review loop; confidence via confidence.ts
 */
import type { Claim } from "../research/claimTypes.ts";
import { computeConfidence, type TieredSource } from "./confidence.ts";
import { SPECS, type Draft } from "./elements.ts";
import type { Epistemic, Meta, ModelName, NkgEdge, NkgNode, NodeType, ProvenanceItem, ReviewState, Spoiler } from "./types.ts";

export interface LayerInput {
  layer: string;
  author: ModelName;
  drafts: Draft[];
  status: Record<string, ReviewState>;
}

export interface Rejection {
  layer: string;
  id: string;
  kind: string;
  reason: string;
}
export interface FinalizeNote {
  layer: string;
  id: string;
  note: string;
}

export interface FinalizeResult {
  nodes: NkgNode[];
  edges: NkgEdge[];
  rejections: Rejection[];
  notes: FinalizeNote[];
}

export interface FinalizeContext {
  claims: Map<string, Claim>;
  sources: Map<string, TieredSource>;
  phaseIds: Set<string>;
  /**
   * Phase label → id (CP-027). Models sometimes write the phase label ("序盤") where an id ("ph1") is required;
   * an exact (NFKC, trimmed) label match is mapped to its id deterministically and noted. Unknown → as before.
   */
  phaseByLabel?: Map<string, string>;
  /** Modules enabled for generation (M04 controls disclosure_phase). */
  enabled: Set<string>;
  defaultCoverage: string | null;
}

const opposite = (m: ModelName): ModelName => (m === "luna" ? "haiku" : "luna");
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : []);
/** Phase id for v: an id as is, or the id of a phase whose label equals v (CP-027); else the raw value. */
function resolvePhase(v: unknown, ctx: FinalizeContext, note: (n: string) => void, field: string): string {
  const raw = str(v);
  if (!raw || ctx.phaseIds.has(raw)) return raw;
  const id = ctx.phaseByLabel?.get(raw.normalize("NFKC"));
  if (id) {
    note(`${field} label "${raw}" → ${id}`);
    return id;
  }
  return raw;
}
const EPISTEMIC = new Set(["canon", "consensus", "fan_theory", "sfsh_analysis"]);
const SPOILER = new Set(["none", "mid", "ending"]);

interface Item {
  layer: string;
  author: ModelName;
  review: ReviewState;
  d: Draft;
}

export function finalizeLayers(layers: LayerInput[], ctx: FinalizeContext): FinalizeResult {
  const rejections: Rejection[] = [];
  const notes: FinalizeNote[] = [];
  const items: Item[] = [];
  for (const l of layers) for (const d of l.drafts) items.push({ layer: l.layer, author: l.author, review: l.status[d.id] ?? "agreed", d });

  const reject = (it: Item, reason: string) => rejections.push({ layer: it.layer, id: it.d.id, kind: it.d._type, reason });
  const note = (it: Item, n: string) => notes.push({ layer: it.layer, id: it.d.id, note: n });

  const directProv = (refs: string[]): { prov: ProvenanceItem[]; used: string[] } => {
    const prov: ProvenanceItem[] = [];
    const used: string[] = [];
    const seen = new Set<string>();
    for (const cid of refs) {
      const c = ctx.claims.get(cid);
      if (!c) continue;
      used.push(cid);
      for (const sid of c.source_ids) {
        if (!ctx.sources.has(sid)) continue;
        const key = `${sid}|claim:${cid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prov.push({ source_id: sid, locator: `claim:${cid}`, support: "direct" });
      }
    }
    return { prov, used };
  };

  // ---- nodes: fixed point (rejecting one node can invalidate others) ----
  let nodeItems = items.filter((it) => !SPECS[it.d._type].edge);
  let built = new Map<string, NkgNode>();
  for (let iter = 0; iter < 20; iter++) {
    const alive = new Map(nodeItems.map((it) => [it.d.id, it] as const));
    const typeOf = (id: string): NodeType | undefined => alive.get(id)?.d._type as NodeType | undefined;
    const direct = new Map<string, ReturnType<typeof directProv>>();
    for (const it of nodeItems) {
      const refs = it.d._type === "Interpretation" ? [...strList(it.d.claim_refs), ...positionsOf(it.d).flatMap((p) => p.refs)] : strList(it.d.claim_refs);
      direct.set(it.d.id, directProv(refs));
    }
    // provenance resolution with based_on (memoized, cycle-safe)
    const memo = new Map<string, ProvenanceItem[]>();
    const stack = new Set<string>();
    const provOf = (id: string): ProvenanceItem[] => {
      if (memo.has(id)) return memo.get(id)!;
      const dp = direct.get(id);
      if (!dp) return [];
      if (dp.prov.length) {
        memo.set(id, dp.prov);
        return dp.prov;
      }
      if (stack.has(id)) return [];
      stack.add(id);
      const it = alive.get(id)!;
      const seen = new Set<string>();
      const inf: ProvenanceItem[] = [];
      for (const b of strList(it.d.based_on)) {
        if (b === id || !alive.has(b)) continue;
        for (const p of provOf(b)) {
          const key = `${p.source_id}|${p.locator}`;
          if (seen.has(key)) continue;
          seen.add(key);
          inf.push({ source_id: p.source_id, locator: p.locator, support: "inferred" });
        }
      }
      stack.delete(id);
      if (stack.size === 0) memo.set(id, inf);
      return inf;
    };

    const nextItems: Item[] = [];
    const nextBuilt = new Map<string, NkgNode>();
    let changed = false;
    for (const it of nodeItems) {
      const dp = direct.get(it.d.id)!;
      const basedOn = strList(it.d.based_on).filter((b) => b !== it.d.id && alive.has(b));
      if (!dp.used.length && !basedOn.length) {
        reject(it, "no_basis: no valid claim_refs and no valid based_on (C-7)");
        changed = true;
        continue;
      }
      const prov = provOf(it.d.id);
      if (!prov.length) {
        reject(it, "no_provenance: claims/basis nodes resolve to no carded source");
        changed = true;
        continue;
      }
      const node = buildNode(it, basedOn, prov, !dp.prov.length, typeOf, ctx, (r) => reject(it, r), iter === 0 ? (n) => note(it, n) : () => {});
      if (!node) {
        changed = true;
        continue;
      }
      nextItems.push(it);
      nextBuilt.set(node.id, node);
    }
    nodeItems = nextItems;
    built = nextBuilt;
    if (!changed) break;
  }
  // second pass for ref lists that depend on the final node set (cause_refs, reasoning_refs, context_refs, based_on)
  const finalIds = new Set(built.keys());
  const finalType = (id: string) => built.get(id)?.type;
  for (const n of built.values()) {
    n.based_on = n.based_on.filter((b) => finalIds.has(b));
    if (n.type === "EmotionBeat") n.cause_refs = n.cause_refs.filter((r) => finalIds.has(r));
    if (n.type === "IconicMoment") n.context_refs = n.context_refs.filter((r) => finalType(r) === "Context");
    if (n.type === "Quiz") {
      n.reasoning_refs = n.reasoning_refs.filter((r) => finalIds.has(r));
      // Models sometimes put claim ids here (CP-020). Fall back to the quiz's own based_on node ids.
      if (!n.reasoning_refs.length) n.reasoning_refs = (n.based_on ?? []).filter((r) => finalIds.has(r));
    }
  }
  const nodes: NkgNode[] = [];
  for (const it of nodeItems) {
    const n = built.get(it.d.id)!;
    if (n.type === "Quiz" && !n.reasoning_refs.length) {
      reject(it, "quiz_without_reasoning_refs");
      continue;
    }
    nodes.push(n);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));

  // ---- edges ----
  const edges: NkgEdge[] = [];
  for (const it of items.filter((x) => SPECS[x.d._type].edge)) {
    const e = buildEdge(it, nodeById, ctx, directProv, (r) => reject(it, r), (n) => note(it, n));
    if (e) edges.push(e);
  }
  return { nodes, edges, rejections, notes };
}

function positionsOf(d: Draft): { claim: string; epistemic: string; refs: string[] }[] {
  const ps = Array.isArray(d.positions) ? d.positions : [];
  return ps
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({ claim: str(p.claim), epistemic: str(p.epistemic), refs: strList(p.claim_refs) }));
}

function baseMeta(it: Item, prov: ProvenanceItem[], inferredOnly: boolean, ctx: FinalizeContext, note: (n: string) => void): Meta {
  let epistemic = (EPISTEMIC.has(str(it.d.epistemic)) ? str(it.d.epistemic) : "sfsh_analysis") as Epistemic;
  if (inferredOnly && epistemic !== "sfsh_analysis") {
    note(`epistemic ${epistemic} → sfsh_analysis (basis is based_on only)`);
    epistemic = "sfsh_analysis";
  }
  let phase: string | null = resolvePhase(it.d.phase_ref, ctx, note, "phase_ref") || null;
  if (phase && !ctx.phaseIds.has(phase)) {
    note(`phase_ref ${phase} unknown → null`);
    phase = null;
  }
  const spoiler = (SPOILER.has(str(it.d.spoiler)) ? str(it.d.spoiler) : "none") as Spoiler;
  return {
    provenance: prov,
    confidence: computeConfidence(prov, ctx.sources, it.review),
    epistemic,
    coverage_ref: str(it.d.coverage_ref) || ctx.defaultCoverage,
    phase_ref: phase,
    spoiler,
    authored_by: it.author,
    reviewed_by: opposite(it.author),
    review: it.review,
  };
}

function buildNode(
  it: Item,
  basedOn: string[],
  prov: ProvenanceItem[],
  inferredOnly: boolean,
  typeOf: (id: string) => NodeType | undefined,
  ctx: FinalizeContext,
  reject: (r: string) => void,
  note: (n: string) => void,
): NkgNode | null {
  const d = it.d;
  const label = str(d.label);
  if (!label) return reject("empty_label"), null;
  const phaseOrNull = (v: unknown, field: string): string | null => {
    const p = resolvePhase(v, ctx, note, field) || null;
    if (p && !ctx.phaseIds.has(p)) {
      note(`${field} ${p} unknown → null`);
      return null;
    }
    return p;
  };
  const need = (field: string): string | null => {
    const v = str(d[field]);
    if (!v) reject(`empty_${field}`);
    return v || null;
  };
  const base = {
    id: d.id,
    module: SPECS[d._type].module,
    label,
    ...(str(d.summary) ? { summary: str(d.summary) } : {}),
    ...(str(d.analysis) ? { analysis: str(d.analysis) } : {}),
    based_on: basedOn,
    meta: baseMeta(it, prov, inferredOnly, ctx, note),
  };
  switch (d._type) {
    case "Character":
    case "Faction":
    case "Outcome":
    case "Secret":
      return { ...base, type: d._type } as NkgNode;
    case "Event": {
      const so = typeof d.story_order === "number" && Number.isInteger(d.story_order) && d.story_order >= 1 ? d.story_order : null;
      const dp = ctx.enabled.has("M04") ? phaseOrNull(d.disclosure_phase, "disclosure_phase") : null;
      return { ...base, type: "Event", story_order: so, disclosure_phase: dp };
    }
    case "Why":
      return { ...base, type: "Why", level: d.level as never, factor_kind: d.factor_kind as never };
    case "Motive": {
      const owner = str(d.owner);
      if (typeOf(owner) !== "Character") return reject(`owner ${owner || "(empty)"} is not a Character`), null;
      return { ...base, type: "Motive", owner, kind: d.kind as never, phase_from: phaseOrNull(d.phase_from, "phase_from"), phase_to: phaseOrNull(d.phase_to, "phase_to") };
    }
    case "Arc": {
      const character = str(d.character);
      if (typeOf(character) !== "Character") return reject(`character ${character || "(empty)"} is not a Character`), null;
      const i = need("initial_state"), f = need("final_state"), t = need("arc_type");
      if (!i || !f || !t) return null;
      return { ...base, type: "Arc", character, initial_state: i, final_state: f, arc_type: t };
    }
    case "WorldRule": {
      const c = need("consequence");
      if (!c) return null;
      return { ...base, type: "WorldRule", kind: d.kind as never, consequence: c };
    }
    case "Setup": {
      const m = need("meaning");
      if (!m) return null;
      return { ...base, type: "Setup", meaning: m };
    }
    case "Theme": {
      const q = need("question"), t = need("tension");
      if (!q || !t) return null;
      return { ...base, type: "Theme", question: q, values: strList(d.values), tension: t };
    }
    case "EmotionBeat": {
      const phase = resolvePhase(d.phase, ctx, note, "phase");
      if (!ctx.phaseIds.has(phase)) return reject(`phase ${phase || "(empty)"} unknown`), null;
      const e = need("emotion");
      if (!e) return null;
      const raw = typeof d.intensity === "number" ? Math.round(d.intensity) : 3;
      return { ...base, type: "EmotionBeat", phase, emotion: e, intensity: Math.min(5, Math.max(1, raw)), cause_refs: strList(d.cause_refs) };
    }
    case "Context":
      return { ...base, type: "Context", kind: d.kind as never };
    case "IconicMoment": {
      const ev = str(d.event_ref);
      if (typeOf(ev) !== "Event") return reject(`event_ref ${ev || "(empty)"} is not an Event`), null;
      const w = need("why_famous");
      if (!w) return null;
      return { ...base, type: "IconicMoment", event_ref: ev, why_famous: w, context_refs: strList(d.context_refs) };
    }
    case "Interpretation": {
      const topic = need("topic");
      if (!topic) return null;
      const positions = [];
      for (const p of positionsOf(d)) {
        if (!p.claim || !["canon", "consensus", "fan_theory"].includes(p.epistemic)) continue;
        const pv: ProvenanceItem[] = [];
        const seen = new Set<string>();
        for (const cid of p.refs) {
          const c = ctx.claims.get(cid);
          if (!c) continue;
          for (const sid of c.source_ids) {
            if (!ctx.sources.has(sid) || seen.has(`${sid}|${cid}`)) continue;
            seen.add(`${sid}|${cid}`);
            pv.push({ source_id: sid, locator: `claim:${cid}`, support: "direct" });
          }
        }
        if (!pv.length) {
          note(`position dropped (no valid claim_refs): ${p.claim.slice(0, 30)}`);
          continue;
        }
        positions.push({ claim: p.claim, epistemic: p.epistemic as "canon" | "consensus" | "fan_theory", provenance: pv });
      }
      if (!positions.length) return reject("interpretation_without_supported_positions"), null;
      return { ...base, type: "Interpretation", topic, positions };
    }
    case "Quiz": {
      const q = need("question"), a = need("answer");
      if (!q || !a) return null;
      return { ...base, type: "Quiz", question: q, answer: a, reasoning_refs: strList(d.reasoning_refs), quiz_type: d.quiz_type as never };
    }
    default:
      return reject(`unknown node type ${d._type}`), null;
  }
}

function buildEdge(
  it: Item,
  nodes: Map<string, NkgNode>,
  ctx: FinalizeContext,
  directProv: (refs: string[]) => { prov: ProvenanceItem[]; used: string[] },
  reject: (r: string) => void,
  note: (n: string) => void,
): NkgEdge | null {
  const d = it.d;
  let from = str(d.from);
  const to = str(d.to);
  if (d._type === "Knows") {
    const holder = str(d.holder) || from;
    if (holder !== "audience" && nodes.get(holder)?.type !== "Character") return reject(`holder ${holder || "(empty)"} is not a Character or "audience"`), null;
    if (nodes.get(to)?.type !== "Secret") return reject(`to ${to} is not a Secret`), null;
    if (from !== holder) note(`from ${from} → holder ${holder}`);
    from = holder;
  } else if (!nodes.has(from)) return reject(`dangling from ${from || "(empty)"}`), null;
  if (!(d._type === "About" && to === "work") && !nodes.has(to)) return reject(`dangling to ${to || "(empty)"}`), null;

  const dp = directProv(strList(d.claim_refs));
  const basis = strList(d.based_on).filter((b) => nodes.has(b));
  let prov = dp.prov;
  let inferredOnly = false;
  if (!dp.used.length && !basis.length) return reject("no_basis: no valid claim_refs and no valid based_on (C-7)"), null;
  if (!prov.length) {
    const seen = new Set<string>();
    prov = [];
    for (const b of basis)
      for (const p of nodes.get(b)!.meta.provenance) {
        const key = `${p.source_id}|${p.locator}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prov.push({ source_id: p.source_id, locator: p.locator, support: "inferred" });
      }
    inferredOnly = true;
    if (!prov.length) return reject("no_provenance"), null;
  }
  const meta = baseMeta(it, prov, inferredOnly, ctx, note);
  const base = { id: d.id, from, to, meta };
  const phaseOrNull = (v: unknown, field: string): string | null => {
    const p = resolvePhase(v, ctx, note, field) || null;
    if (p && !ctx.phaseIds.has(p)) {
      note(`${field} ${p} unknown → null`);
      return null;
    }
    return p;
  };
  switch (d._type) {
    case "Relation": {
      let changed = str(d.changed_by) || null;
      if (changed && nodes.get(changed)?.type !== "Event") {
        note(`changed_by ${changed} is not an Event → null`);
        changed = null;
      }
      return { ...base, type: "Relation", kind: str(d.kind) || "関係", valence: d.valence as never, phase_from: phaseOrNull(d.phase_from, "phase_from"), phase_to: phaseOrNull(d.phase_to, "phase_to"), changed_by: changed };
    }
    case "Causes":
      return { ...base, type: "Causes", kind: d.kind as never };
    case "Knows": {
      const phase = resolvePhase(d.phase, ctx, note, "phase");
      if (!ctx.phaseIds.has(phase)) return reject(`phase ${phase || "(empty)"} unknown`), null;
      return { ...base, type: "Knows", holder: from, phase, state: d.state as never };
    }
    case "Explains":
      return { ...base, type: "Explains", refs: strList(d.refs).filter((r) => nodes.has(r)) };
    case "Drives":
    case "ConflictsWith":
    case "TurnsAt":
    case "Constrains":
    case "PaysOff":
    case "Embodies":
    case "Evokes":
    case "About":
      return { ...base, type: d._type } as NkgEdge;
    default:
      return reject(`unknown edge type ${d._type}`), null;
  }
}

