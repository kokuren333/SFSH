import { BOOK_MENU, BOOK_TYPES } from "../nkg/bookMenu.ts";
import type { BookNode } from "../nkg/types.ts";
/**
 * WP-2.2 public projection (REQUIREMENTS §2.6). Deterministic, no model calls.
 *
 * nkg.json + validation.json + research/sources.json + work.json (+ gen/tags.json) → gen/projection.json:
 * a PublicWork whose page text is empty (written later by writePages). Only display fields of elements with
 * validation `public_eligible === true` are copied; edges also need both endpoints public ("audience" holder
 * of a Knows edge counts as public). Sources = bibliographic data of sources referenced by included
 * elements only. Never copied: excerpts, claims, provenance, confidence basis, review data, model names,
 * local paths, raw text.
 *
 * gen/projection.json additionally carries `chain_dropout` (CP-029 ruling 2 note; internal, never copied into
 * public.json by compose): elements kept out of the projection only because an element they depend on
 * (sfsh_analysis based_on, edge endpoints) is not public-eligible. It is a count + warning, never a stop (P-1).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ContextItem,
  IconicItem,
  InterpretationItem,
  PlotNode,
  PublicArc,
  PublicCharacter,
  PublicEmotionBeat,
  PublicEvent,
  PublicGap,
  PublicMotive,
  PublicPhase,
  PublicRelation,
  PublicSetup,
  PublicSource,
  PublicWork,
  PublicWorldRule,
  PublicWorkHeader,
  QuizItem,
  ThemeItem,
  VizMatrix,
  VizTimeline,
} from "../../../site/src/public-types.ts";
import type { StageContext, StageResult } from "../job/context.ts";
import { readSourceCards, writeJson } from "../nkg/io.ts";
import type { ArcNode, CausesEdge, EmotionBeatNode, EventNode, ExplainsEdge, KnowsEdge, MotiveNode, Nkg, NkgEdge, NkgNode, RelationEdge, SetupNode, Spoiler, WhyNode, WorldRuleNode } from "../nkg/types.ts";
import type { SourceCard } from "../research/types.ts";
import { readWork } from "../works/store.ts";
import type { Work } from "../works/types.ts";
import { checkPublicWork } from "./check.ts";
import { GEN_FILES, MAX_TAGS, loadGenreVocab, maxSpoiler, readFinalTags, readNkg, readValidation, type VocabEntry } from "./io.ts";

/** Japanese display names of the aspects (modules) for `gaps` (fixed table). */
export const ASPECT_LABELS: Record<string, string> = {
  ...Object.fromEntries(BOOK_MENU.map(m=>[m.module,m.label])),
  M01: "人物関係",
  M02: "リバースプロット",
  M03: "因果関係",
  M04: "時系列の二重化",
  M05: "知識状態",
  M06: "動機・欲望",
  M07: "キャラクター変容",
  M08: "世界観・ルール",
  M09: "伏線と回収",
  M10: "テーマ・思想",
  M11: "感情曲線",
  M12: "文化的文脈",
  extra: "追加機能",
};

/** Reverse-plot depth cap (Outcome = depth 0). */
export const PLOT_DEPTH_CAP = 6;
/** Max quiz items per work (§2.4 [暫定]). */
export const MAX_QUIZ = 10;
export const AUDIENCE_ID = "audience";
export const AUDIENCE_LABEL = "読者";

export interface ProjectionInput {
  nkg: Nkg;
  validation: { elements: Record<string, { public_eligible: boolean } | undefined> };
  cards: SourceCard[];
  work: Partial<Work> | null;
  /** Final tags (gen/tags.json), already vocab-filtered. */
  tags: string[];
  genreVocab: VocabEntry[];
}

export interface ProjectionStats {
  elements_total: number;
  elements_public: number;
  elements_included: number;
  characters: number;
  relations: number;
  trees: number;
  plot_nodes: number;
  matrix_secrets: number;
  matrix_holders: number;
  matrix_cells: number;
  timeline_events: number;
  themes: number;
  contexts: number;
  iconic: number;
  interpretations: number;
  quiz: number;
  factions: number;
  events: number;
  motives: number;
  arcs: number;
  world_rules: number;
  setups: number;
  emotion_beats: number;
  /** Public motives / arcs left out because their owner / character is not a public character. */
  orphan_motives_arcs: number;
  sources_kept: number;
  sources_total: number;
  gaps: number;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s ? s : null;
};
const MEDIA = new Set(["book", "novel", "manga", "anime", "film", "drama", "game", "other"]);
const STATUSES = new Set(["completed", "ongoing", "unknown"]);
const TIERS = new Set(["T1", "T2", "T3", "T4", "T5"]);

/** Ids that public page text may cite (every element `id` present in a PublicWork, pages excluded except quiz). */
export function citableIds(pw: PublicWork): Map<string, { spoiler: Spoiler; epistemic: string }> {
  const m = new Map<string, { spoiler: Spoiler; epistemic: string }>();
  const add = (id: string, spoiler: Spoiler, epistemic: string) => m.set(id, { spoiler, epistemic });
  for (const n of pw.book?.nodes ?? []) add(n.id,"none",n.epistemic);
  for (const c of pw.viz.relations.characters) add(c.id, c.spoiler, c.epistemic);
  for (const r of pw.viz.relations.relations) add(r.id, r.spoiler, r.epistemic);
  const walk = (n: PlotNode) => {
    add(n.id, n.spoiler, n.epistemic);
    n.children.forEach(walk);
  };
  pw.viz.reverse_plot.trees.forEach(walk);
  for (const s of pw.viz.matrix?.secrets ?? []) add(s.id, s.spoiler, s.epistemic);
  const el = pw.elements;
  for (const x of [...el.events, ...el.motives, ...el.arcs, ...el.world_rules, ...el.setups, ...el.emotion_beats]) add(x.id, x.spoiler, x.epistemic);
  for (const e of pw.viz.timeline?.events ?? []) if (!m.has(e.id)) add(e.id, e.spoiler, "unknown");
  for (const t of pw.pages.themes.items) add(t.id, t.spoiler, t.epistemic);
  for (const c of pw.pages.context.items) add(c.id, c.spoiler, c.epistemic);
  for (const i of pw.pages.context.iconic) add(i.id, i.spoiler, i.epistemic);
  for (const i of pw.pages.interpretations.items) add(i.id, i.spoiler, "fan_theory");
  for (const q of pw.pages.quiz) add(q.id, q.spoiler, "sfsh_analysis");
  return m;
}

/** Max roots listed in `chain_dropout.roots`. */
export const CHAIN_DROPOUT_TOP_ROOTS = 20;

export interface ChainDropout {
  /** Elements (nodes + edges) excluded only because a dependency is not public-eligible. */
  count: number;
  by_type: Record<string, number>;
  /** Elements that fail their own condition and drag dependents out (top CHAIN_DROPOUT_TOP_ROOTS by dependents). */
  roots: { root_id: string; root_type: string; own_reason: string; dependents: number }[];
}

const SPECIAL_ENDPOINTS = new Set([AUDIENCE_ID, "work"]);

/**
 * Chain dropout (CP-029 ruling 2 note). Read-only over the same eligibility flags the projection uses
 * (validation `public_eligible`, computed by nkg/publicRules.ts); eligibility semantics are not changed.
 *
 * An element counts when it is kept out of the projection's public sets (pubNodes / pubEdges) and its own
 * condition is not the cause:
 *  - node: sfsh_analysis, non-empty based_on, every non-eligible based_on id is a known node, >=1 based_on node
 *    not eligible, and not on a based_on cycle of non-eligible nodes (a cycle is the node's own failure);
 *  - edge: either not eligible as an sfsh_analysis edge with >=1 non-eligible endpoint node, or eligible itself
 *    but dropped by the projection's endpoint gate because an endpoint node is not eligible.
 * Everything else that is not public is an "own" failure (grade / provenance / empty based_on / cycle / dangling
 * based_on / not validated). Roots = the own-failure nodes reached by following non-eligible dependencies;
 * `dependents` = counted elements whose root set includes the root. Downstream placement (types without a
 * public slot, depth cap, orphan motives) is not considered.
 */
export function computeChainDropout(nkg: Nkg, validation: ProjectionInput["validation"]): ChainDropout {
  const vEntry = (id: string) => validation.elements?.[id] as { public_eligible: boolean; reasons?: string[] } | undefined;
  const eligible = (id: string) => vEntry(id)?.public_eligible === true;
  const nodes = new Map<string, NkgNode>();
  for (const n of nkg.nodes ?? []) if (typeof n?.id === "string") nodes.set(n.id, n);
  const basedOn = (n: NkgNode): string[] => (Array.isArray(n.based_on) ? n.based_on.filter((x): x is string => typeof x === "string") : []);
  const badDeps = (n: NkgNode) => basedOn(n).filter((d) => !eligible(d));

  const ownReason = (el: NkgNode | NkgEdge, fixed?: string): string => {
    const v = vEntry(el.id);
    if (!v) return "not validated (dropped by schema / reference checks)";
    const r = (v.reasons ?? []).find((x) => typeof x === "string" && x.trim());
    const text = fixed ?? r ?? `${el.meta?.epistemic ?? "?"} condition not met (grade ${el.meta?.confidence?.grade ?? "?"})`;
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  };

  // does n reach itself over based_on links of non-eligible sfsh_analysis nodes?
  const onCycle = (n: NkgNode): boolean => {
    const seen = new Set<string>();
    const stack = [...badDeps(n)];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === n.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const m = nodes.get(id);
      if (m && !eligible(id) && m.meta?.epistemic === "sfsh_analysis") stack.push(...badDeps(m));
    }
    return false;
  };

  type NodeClass = { kind: "ok" } | { kind: "own"; reason: string } | { kind: "chain"; deps: string[] };
  const cls = new Map<string, NodeClass>();
  for (const [id, n] of nodes) {
    let c: NodeClass;
    if (eligible(id)) c = { kind: "ok" };
    else if (!vEntry(id) || n.meta?.epistemic !== "sfsh_analysis" || !basedOn(n).length) c = { kind: "own", reason: ownReason(n) };
    else {
      const deps = badDeps(n);
      const unknown = deps.filter((d) => !nodes.has(d));
      if (!deps.length) c = { kind: "own", reason: ownReason(n) };
      else if (unknown.length) c = { kind: "own", reason: ownReason(n, `based_on references unknown node(s): ${unknown.join(", ")}`) };
      else if (onCycle(n)) c = { kind: "own", reason: ownReason(n, "based_on cycle") };
      else c = { kind: "chain", deps };
    }
    cls.set(id, c);
  }

  const rootMemo = new Map<string, Set<string>>();
  const rootsOfNode = (id: string, visiting = new Set<string>()): Set<string> => {
    const memo = rootMemo.get(id);
    if (memo) return memo;
    const c = cls.get(id);
    const out = new Set<string>();
    if (!c || c.kind === "ok") return out;
    if (c.kind === "own") out.add(id);
    else if (!visiting.has(id)) {
      visiting.add(id);
      for (const d of c.deps) for (const r of rootsOfNode(d, visiting)) out.add(r);
      visiting.delete(id);
    }
    rootMemo.set(id, out);
    return out;
  };

  const counted: { type: string; roots: Set<string> }[] = [];
  for (const [id, c] of cls) if (c.kind === "chain") counted.push({ type: nodes.get(id)!.type, roots: rootsOfNode(id) });
  for (const e of nkg.edges ?? []) {
    if (typeof e?.id !== "string") continue;
    // endpoints that are real nodes failing eligibility (special endpoints / unknown ids are not dependencies)
    const badEnds = [e.from, e.to].filter((x) => typeof x === "string" && !SPECIAL_ENDPOINTS.has(x) && nodes.has(x) && !eligible(x));
    if (!badEnds.length) continue;
    const v = vEntry(e.id);
    if (!v) continue; // not validated -> own failure
    if (!v.public_eligible && e.meta?.epistemic !== "sfsh_analysis") continue; // own condition (grade / provenance)
    const roots = new Set<string>();
    for (const x of badEnds) for (const r of rootsOfNode(x)) roots.add(r);
    counted.push({ type: e.type, roots });
  }

  const byType: Record<string, number> = {};
  const deps = new Map<string, number>();
  for (const c of counted) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    for (const r of c.roots) deps.set(r, (deps.get(r) ?? 0) + 1);
  }
  const roots = [...deps.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, CHAIN_DROPOUT_TOP_ROOTS)
    .map(([rid, n]) => {
      const c = cls.get(rid);
      return { root_id: rid, root_type: nodes.get(rid)?.type ?? "unknown", own_reason: c?.kind === "own" ? c.reason : "unknown", dependents: n };
    });
  const sortedByType: Record<string, number> = {};
  for (const k of Object.keys(byType).sort()) sortedByType[k] = byType[k];
  return { count: counted.length, by_type: sortedByType, roots };
}

export function buildProjection(inp: ProjectionInput): { projection: PublicWork; stats: ProjectionStats; chainDropout: ChainDropout } {
  const { nkg } = inp;
  const eligible = (id: string) => inp.validation.elements?.[id]?.public_eligible === true;
  const pubNodes = nkg.nodes.filter((n) => typeof n.id === "string" && eligible(n.id));
  const pubNode = new Map(pubNodes.map((n) => [n.id, n] as const));
  const edgePublic = (e: NkgEdge) => {
    if (!eligible(e.id)) return false;
    const ok = (id: string, holderSide: boolean) => pubNode.has(id) || (holderSide && e.type === "Knows" && id === AUDIENCE_ID);
    return ok(e.from, true) && ok(e.to, false);
  };
  const pubEdges = nkg.edges.filter((e) => typeof e.id === "string" && edgePublic(e));
  const enabled = new Set((nkg.work.module_selection ?? []).filter((m) => m.enabled).map((m) => m.module as string));

  // ---- source bibliographic data (card preferred over the nkg copy) ----
  type SrcInfo = { title: string; publisher: string | null; url: string; fetched_at: string; tier: string; license: string | null };
  const srcInfo = new Map<string, SrcInfo>();
  const srcOrder: string[] = [];
  for (const s of nkg.sources ?? []) {
    if (!s?.source_id || !s.url) continue;
    srcInfo.set(s.source_id, { title: s.title ?? "", publisher: s.publisher || null, url: s.url, fetched_at: s.fetched_at ?? "", tier: s.tier, license: s.license ?? null });
  }
  for (const c of inp.cards ?? []) {
    if (!c?.source_id || !c.url) continue;
    srcInfo.set(c.source_id, { title: c.title ?? "", publisher: c.publisher || null, url: c.url, fetched_at: c.fetched_at ?? "", tier: c.tier, license: c.license ?? null });
    srcOrder.push(c.source_id);
  }
  for (const s of nkg.sources ?? []) if (s?.source_id && srcInfo.has(s.source_id) && !srcOrder.includes(s.source_id)) srcOrder.push(s.source_id);
  const refsOf = (prov: { source_id: string }[] | undefined) => uniq((prov ?? []).map((p) => p?.source_id).filter((s): s is string => typeof s === "string" && srcInfo.has(s)));
  const referenced = new Set<string>();
  const included = new Set<string>();
  const include = (el: NkgNode | NkgEdge): string[] => {
    included.add(el.id);
    const r = refsOf(el.meta?.provenance);
    r.forEach((s) => referenced.add(s));
    return r;
  };
  const base = (el: NkgNode | NkgEdge) => ({ id: el.id, epistemic: el.meta.epistemic, grade: el.meta.confidence.grade, spoiler: el.meta.spoiler });

  // ---- viz.relations ----
  const charNodes = pubNodes.filter((n) => n.type === "Character");
  const charIds = new Set(charNodes.map((n) => n.id));
  const relEdges = pubEdges.filter((e): e is RelationEdge => e.type === "Relation");
  const charRels = relEdges.filter((e) => charIds.has(e.from) && charIds.has(e.to));
  // faction membership = a public Character↔Faction Relation (smallest faction id wins, then smallest edge id)
  const faction = new Map<string, { id: string; edge: RelationEdge }>();
  for (const e of relEdges) {
    const pair: [string, string][] = [
      [e.from, e.to],
      [e.to, e.from],
    ];
    for (const [c, f] of pair) {
      if (charIds.has(c) && pubNode.get(f)?.type === "Faction") {
        const cur = faction.get(c);
        if (!cur || f < cur.id || (f === cur.id && e.id < cur.edge.id)) faction.set(c, { id: f, edge: e });
      }
    }
  }
  const degree = new Map<string, number>();
  for (const e of charRels) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ranked = [...charNodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || byId(a, b));
  const prominence = new Map(ranked.map((n, i) => [n.id, i + 1] as const));
  const characters: PublicCharacter[] = ranked.map((n) => {
    const fm = faction.get(n.id);
    const fnode = fm ? pubNode.get(fm.id)! : null;
    if (fm) {
      include(fm.edge);
      include(fnode!);
    }
    return {
      ...base(n),
      // membership (edge) and the faction label are displayed with the character → spoiler covers both
      spoiler: maxSpoiler(n.meta.spoiler, fm?.edge.meta.spoiler, fnode?.meta.spoiler),
      source_refs: include(n),
      label: str(n.label),
      summary: strOrNull(n.summary),
      faction: fm?.id ?? null,
      prominence: prominence.get(n.id)!,
    };
  });
  const factions = uniq(characters.map((c) => c.faction).filter((f): f is string => !!f))
    .sort()
    .map((id) => ({ id, label: str(pubNode.get(id)!.label) }));
  const relations: PublicRelation[] = charRels.map((e) => {
    const ev = e.changed_by ? pubNode.get(e.changed_by) : undefined;
    const changer = ev && ev.type === "Event" ? (ev as EventNode) : null;
    return {
      ...base(e),
      // the change label is shown with the relation → the relation's spoiler covers the event's
      spoiler: maxSpoiler(e.meta.spoiler, changer?.meta.spoiler),
      source_refs: include(e),
      from: e.from,
      to: e.to,
      kind: str(e.kind),
      valence: e.valence,
      phase_from: e.phase_from ?? null,
      phase_to: e.phase_to ?? null,
      changed_by_label: changer ? str(changer.label) || null : null,
    };
  });

  // ---- viz.reverse_plot ----
  const explainsInto = new Map<string, ExplainsEdge[]>();
  for (const e of pubEdges) {
    if (e.type !== "Explains" || pubNode.get(e.from)?.type !== "Why") continue;
    if (!explainsInto.has(e.to)) explainsInto.set(e.to, []);
    explainsInto.get(e.to)!.push(e);
  }
  for (const list of explainsInto.values()) list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : byId(a, b)));
  const plotNode = (n: NkgNode, depth: number, seen: Set<string>, edgeSpoiler: Spoiler | null): PlotNode => {
    include(n);
    const isWhy = n.type === "Why";
    const children: PlotNode[] = [];
    const next: { e: ExplainsEdge; child: NkgNode }[] = [];
    if (depth < PLOT_DEPTH_CAP) {
      for (const e of explainsInto.get(n.id) ?? []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        next.push({ e, child: pubNode.get(e.from)! });
      }
    }
    for (const { e, child } of next) {
      include(e);
      children.push(plotNode(child, depth + 1, seen, e.meta.spoiler));
    }
    return {
      id: n.id,
      kind: isWhy ? "why" : "outcome",
      level: isWhy ? (n as WhyNode).level : "outcome",
      factor_kind: isWhy ? (n as WhyNode).factor_kind : null,
      label: str(n.label),
      summary: strOrNull(n.summary),
      analysis: strOrNull(n.analysis),
      epistemic: n.meta.epistemic,
      grade: n.meta.confidence.grade,
      spoiler: maxSpoiler(n.meta.spoiler, edgeSpoiler),
      children,
    };
  };
  const size = (p: PlotNode): number => 1 + p.children.reduce((s, c) => s + size(c), 0);
  const trees = pubNodes
    .filter((n) => n.type === "Outcome")
    .map((n) => plotNode(n, 0, new Set([n.id]), null))
    .map((t) => ({ t, s: size(t) }))
    .sort((a, b) => b.s - a.s || byId(a.t, b.t))
    .map((x) => x.t);

  // ---- viz.matrix (M05 + ≥1 public secret; the reader column is always present) ----
  let matrix: VizMatrix | null = null;
  const secretNodes = pubNodes.filter((n) => n.type === "Secret");
  if (enabled.has("M05") && secretNodes.length) {
    const secretIdx = new Map(secretNodes.map((n, i) => [n.id, i] as const));
    const knows = pubEdges.filter((e): e is KnowsEdge => e.type === "Knows" && secretIdx.has(e.to) && (e.holder === AUDIENCE_ID || charIds.has(e.holder)));
    const holderChars = uniq(knows.map((k) => k.holder).filter((h) => h !== AUDIENCE_ID)).sort((a, b) => prominence.get(a)! - prominence.get(b)!);
    const holders = [
      ...holderChars.map((h) => ({ id: h, label: str(pubNode.get(h)!.label), is_audience: false })),
      { id: AUDIENCE_ID, label: AUDIENCE_LABEL, is_audience: true },
    ];
    const holderIdx = new Map(holders.map((h, i) => [h.id, i] as const));
    const phaseOrder = new Map((nkg.work.phases ?? []).map((p) => [p.id, p.order] as const));
    const rowSpoiler = new Map<string, Spoiler>();
    const seenCell = new Set<string>();
    const cells: VizMatrix["cells"] = [];
    const sortedKnows = [...knows].sort(
      (a, b) =>
        secretIdx.get(a.to)! - secretIdx.get(b.to)! ||
        holderIdx.get(a.holder)! - holderIdx.get(b.holder)! ||
        (phaseOrder.get(a.phase) ?? 999) - (phaseOrder.get(b.phase) ?? 999) ||
        byId(a, b),
    );
    for (const k of sortedKnows) {
      const key = `${k.to}\u0000${k.holder}\u0000${k.phase}`;
      if (seenCell.has(key)) continue;
      seenCell.add(key);
      include(k);
      rowSpoiler.set(k.to, maxSpoiler(rowSpoiler.get(k.to), k.meta.spoiler));
      cells.push({ secret: k.to, holder: k.holder, phase: k.phase, state: k.state });
    }
    matrix = {
      secrets: secretNodes.map((n) => {
        include(n);
        return { id: n.id, label: str(n.label), epistemic: n.meta.epistemic, grade: n.meta.confidence.grade, spoiler: maxSpoiler(n.meta.spoiler, rowSpoiler.get(n.id)) };
      }),
      holders,
      cells,
    };
  }

  // ---- viz.timeline (M04 + ≥3 public events with story_order) ----
  let timeline: VizTimeline | null = null;
  const orderedEvents = pubNodes.filter((n): n is EventNode => n.type === "Event" && typeof n.story_order === "number");
  if (enabled.has("M04") && orderedEvents.length >= 3) {
    timeline = {
      events: [...orderedEvents]
        .sort((a, b) => (a.story_order as number) - (b.story_order as number) || byId(a, b))
        .map((n) => {
          include(n);
          return { id: n.id, label: str(n.label), story_order: n.story_order as number, disclosure_phase: n.disclosure_phase ?? null, spoiler: n.meta.spoiler };
        }),
    };
  }

  // ---- page items (element display fields) ----
  const themes: ThemeItem[] = pubNodes
    .filter((n) => n.type === "Theme")
    .map((n) => {
      const t = n as Extract<NkgNode, { type: "Theme" }>;
      return {
        ...base(t),
        source_refs: include(t),
        label: str(t.label),
        question: str(t.question),
        tension: str(t.tension),
        values: (t.values ?? []).map(str).filter(Boolean),
        summary: strOrNull(t.summary),
        analysis: strOrNull(t.analysis),
      };
    });
  const contexts: ContextItem[] = pubNodes
    .filter((n) => n.type === "Context")
    .map((n) => {
      const c = n as Extract<NkgNode, { type: "Context" }>;
      return { ...base(c), source_refs: include(c), kind: c.kind, label: str(c.label), summary: strOrNull(c.summary), analysis: strOrNull(c.analysis) };
    });
  const iconic: IconicItem[] = pubNodes
    .filter((n) => n.type === "IconicMoment")
    .map((n) => {
      const im = n as Extract<NkgNode, { type: "IconicMoment" }>;
      return { ...base(im), source_refs: include(im), label: str(im.label), why_famous: str(im.why_famous), analysis: strOrNull(im.analysis) };
    });
  const interpretations: InterpretationItem[] = pubNodes
    .filter((n) => n.type === "Interpretation")
    .map((n) => {
      const ip = n as Extract<NkgNode, { type: "Interpretation" }>;
      include(ip);
      const positions = (ip.positions ?? [])
        .filter((p) => p && (p.epistemic === "canon" || p.epistemic === "consensus" || p.epistemic === "fan_theory") && str(p.claim))
        .map((p) => {
          const refs = refsOf(p.provenance);
          refs.forEach((s) => referenced.add(s));
          return { claim: str(p.claim), epistemic: p.epistemic, source_refs: refs };
        });
      return { id: ip.id, topic: str(ip.topic) || str(ip.label), positions, spoiler: ip.meta.spoiler };
    });

  // ---- elements (CP-026): events, motives, arcs, world rules, setups, emotion beats ----
  // Pass 1: display fields with empty cross-reference arrays. Pass 2 (once the PublicWork exists) fills the
  // cross-references from public edges whose both endpoints are present in the PublicWork, and raises each
  // item's spoiler to cover the edges it displays. Referenced elements keep their own spoiler.
  const ofType = <T extends NkgNode>(t: string) => pubNodes.filter((n) => n.type === t) as T[];
  const byOwnerProminence =
    <T extends { id: string }>(owner: (x: T) => string) =>
    (a: T, b: T) =>
      prominence.get(owner(a))! - prominence.get(owner(b))! || byId(a, b);
  const events: PublicEvent[] = ofType<EventNode>("Event")
    .sort((a, b) => {
      const ao = typeof a.story_order === "number" ? a.story_order : Infinity;
      const bo = typeof b.story_order === "number" ? b.story_order : Infinity;
      return ao === bo ? byId(a, b) : ao < bo ? -1 : 1;
    })
    .map((n) => ({
      id: n.id,
      label: str(n.label),
      summary: strOrNull(n.summary),
      story_order: typeof n.story_order === "number" ? n.story_order : null,
      phase_ref: n.meta.phase_ref ?? null,
      epistemic: n.meta.epistemic,
      grade: n.meta.confidence.grade,
      spoiler: n.meta.spoiler,
      source_refs: include(n),
      caused_by: [],
      leads_to: [],
    }));
  const allMotives = ofType<MotiveNode>("Motive");
  const allArcs = ofType<ArcNode>("Arc");
  // a motive / arc is shown only when its owner / character is a public character (the id must resolve)
  const motives: PublicMotive[] = allMotives
    .filter((n) => charIds.has(n.owner))
    .map((n) => ({
      id: n.id,
      owner: n.owner,
      kind: n.kind,
      label: str(n.label),
      summary: strOrNull(n.summary),
      analysis: strOrNull(n.analysis),
      phase_from: n.phase_from ?? null,
      phase_to: n.phase_to ?? null,
      drives: [] as string[],
      conflicts_with: [] as string[],
      epistemic: n.meta.epistemic,
      grade: n.meta.confidence.grade,
      spoiler: n.meta.spoiler,
      source_refs: include(n),
    }))
    .sort(byOwnerProminence<PublicMotive>((x) => x.owner));
  const arcs: PublicArc[] = allArcs
    .filter((n) => charIds.has(n.character))
    .map((n) => ({
      id: n.id,
      character: n.character,
      arc_type: str(n.arc_type),
      label: str(n.label),
      initial_state: str(n.initial_state),
      final_state: str(n.final_state),
      summary: strOrNull(n.summary),
      analysis: strOrNull(n.analysis),
      turns_at: [] as string[],
      epistemic: n.meta.epistemic,
      grade: n.meta.confidence.grade,
      spoiler: n.meta.spoiler,
      source_refs: include(n),
    }))
    .sort(byOwnerProminence<PublicArc>((x) => x.character));
  const worldRules: PublicWorldRule[] = ofType<WorldRuleNode>("WorldRule")
    .sort(byId)
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      label: str(n.label),
      summary: strOrNull(n.summary),
      consequence: str(n.consequence),
      constrains: [],
      epistemic: n.meta.epistemic,
      grade: n.meta.confidence.grade,
      spoiler: n.meta.spoiler,
      source_refs: include(n),
    }));
  const setups: PublicSetup[] = ofType<SetupNode>("Setup")
    .sort(byId)
    .map((n) => ({
      id: n.id,
      label: str(n.label),
      meaning: str(n.meaning),
      pays_off: [],
      epistemic: n.meta.epistemic,
      grade: n.meta.confidence.grade,
      spoiler: n.meta.spoiler,
      source_refs: include(n),
    }));
  const beatNodes = ofType<EmotionBeatNode>("EmotionBeat").sort(byId);
  const emotionBeats: PublicEmotionBeat[] = beatNodes.map((n) => ({
    id: n.id,
    phase: n.phase,
    emotion: str(n.emotion),
    intensity: n.intensity,
    label: str(n.label),
    summary: strOrNull(n.summary),
    evoked_by: [],
    epistemic: n.meta.epistemic,
    grade: n.meta.confidence.grade,
    spoiler: n.meta.spoiler,
    source_refs: include(n),
  }));
  const orphanMotivesArcs = allMotives.length - motives.length + (allArcs.length - arcs.length);

  const phases: PublicPhase[] = [...(nkg.work.phases ?? [])].sort((a, b) => a.order - b.order).map((p) => ({ id: p.id, label: str(p.label), order: p.order }));

  // provisional PublicWork (quiz filled below once the citable set is known)
  const pw: PublicWork = {
    schema: "sfsh-public/1",
    work: null as unknown as PublicWorkHeader,
    phases,
    viz: { relations: { characters, relations, factions }, reverse_plot: { trees }, matrix, timeline },
    pages: {
      overview: [],
      figure_notes: { relations: null, reverse_plot: null, matrix: null },
      themes: { intro: [], items: themes },
      context: { intro: [], items: contexts, iconic },
      interpretations: { intro: [], items: interpretations },
      quiz: [],
    },
    elements: { events, motives, arcs, world_rules: worldRules, setups, emotion_beats: emotionBeats },
    gaps: [],
    sources: [],
  };

  const bookNodes = pubNodes.filter(n=>BOOK_TYPES.includes(n.type as never)||n.type==="BookTopic") as BookNode[];
  if (bookNodes.length || nkg.work.kind === "nonfiction") {
    pw.book = {
      nodes:bookNodes.map(n=>({id:n.id,module:n.module,type:n.type,label:n.label,summary:n.summary??null,stance:n.stance,section:n.section,grade:n.meta.confidence.grade,epistemic:n.meta.epistemic,source_refs:include(n)})),
      edges:pubEdges.filter(e=>e.type==="ArgumentLink"||e.type==="ConceptLink").map(e=>({id:e.id,from:e.from,to:e.to,relation:(e as import("../nkg/types.ts").BookEdge).relation,grade:e.meta.confidence.grade,source_refs:include(e)})),
      pages:BOOK_MENU.filter(m=>nkg.work.module_selection.some(s=>s.module===m.module&&s.enabled)).map(m=>({module:m.module,slug:m.slug,label:m.label,blocks:[]})),
    };
  }
  // pass 2: cross-references (public edge, both endpoints present in the PublicWork), ids sorted
  const present = citableIds(pw);
  const typeOfPresent = (id: string) => (present.has(id) ? pubNode.get(id)?.type : undefined);
  const edgesOf = (type: string) => pubEdges.filter((e) => e.type === type).sort(byId);
  const sortRefs = (xs: string[]) => uniq(xs).sort();
  const raise = (item: { spoiler: Spoiler }, e: NkgEdge) => {
    include(e);
    item.spoiler = maxSpoiler(item.spoiler, e.meta.spoiler);
  };
  type Link = { event: string; kind: CausesEdge["kind"] };
  const sortLinks = (xs: Link[]) =>
    xs
      .filter((x, i, a) => a.findIndex((y) => y.event === x.event && y.kind === x.kind) === i)
      .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const evById = new Map(events.map((x) => [x.id, x] as const));
  for (const e of edgesOf("Causes") as CausesEdge[]) {
    const effect = evById.get(e.to);
    const cause = evById.get(e.from);
    if (!effect || !cause || effect === cause) continue;
    effect.caused_by.push({ event: e.from, kind: e.kind });
    cause.leads_to.push({ event: e.to, kind: e.kind });
    raise(effect, e);
    raise(cause, e);
  }
  for (const ev of events) {
    ev.caused_by = sortLinks(ev.caused_by);
    ev.leads_to = sortLinks(ev.leads_to);
  }
  const moById = new Map(motives.map((x) => [x.id, x] as const));
  for (const e of edgesOf("Drives")) {
    const m = moById.get(e.from);
    if (!m || typeOfPresent(e.to) !== "Event") continue;
    m.drives.push(e.to);
    raise(m, e);
  }
  for (const e of edgesOf("ConflictsWith")) {
    const a = moById.get(e.from);
    const b = moById.get(e.to);
    if (!a || !b || a === b) continue;
    a.conflicts_with.push(b.id);
    b.conflicts_with.push(a.id);
    raise(a, e);
    raise(b, e);
  }
  for (const m of motives) {
    m.drives = sortRefs(m.drives);
    m.conflicts_with = sortRefs(m.conflicts_with);
  }
  const arcById = new Map(arcs.map((x) => [x.id, x] as const));
  for (const e of edgesOf("TurnsAt")) {
    const a = arcById.get(e.from);
    if (!a || typeOfPresent(e.to) !== "Event") continue;
    a.turns_at.push(e.to);
    raise(a, e);
  }
  for (const a of arcs) a.turns_at = sortRefs(a.turns_at);
  const wrById = new Map(worldRules.map((x) => [x.id, x] as const));
  for (const e of edgesOf("Constrains")) {
    const w = wrById.get(e.from);
    const t = typeOfPresent(e.to);
    if (!w || (t !== "Event" && t !== "Character")) continue;
    w.constrains.push(e.to);
    raise(w, e);
  }
  for (const w of worldRules) w.constrains = sortRefs(w.constrains);
  const suById = new Map(setups.map((x) => [x.id, x] as const));
  for (const e of edgesOf("PaysOff")) {
    const su = suById.get(e.from);
    if (!su || typeOfPresent(e.to) !== "Event") continue;
    su.pays_off.push(e.to);
    raise(su, e);
  }
  for (const su of setups) su.pays_off = sortRefs(su.pays_off);
  const ebById = new Map(emotionBeats.map((x) => [x.id, x] as const));
  for (const e of edgesOf("Evokes")) {
    const b = ebById.get(e.to);
    if (!b || typeOfPresent(e.from) !== "Event") continue;
    b.evoked_by.push(e.from);
    raise(b, e);
  }
  // cause_refs are node references (no edge): kept when the referenced id is present in the PublicWork
  for (const n of beatNodes) {
    const b = ebById.get(n.id)!;
    b.evoked_by = sortRefs([...b.evoked_by, ...(n.cause_refs ?? []).filter((id) => present.has(id) && id !== n.id)]);
  }

  // quiz: Quiz node display fields (writePages rewrites the text; compose falls back to these)
  const quizNodes = pubNodes.filter((n) => n.type === "Quiz").slice(0, MAX_QUIZ) as Extract<NkgNode, { type: "Quiz" }>[];
  const quizIds = new Set(quizNodes.map((q) => q.id));
  const cite = citableIds(pw);
  const quiz: QuizItem[] = quizNodes.map((q) => {
    include(q);
    return {
      id: q.id,
      quiz_type: q.quiz_type,
      question: str(q.question),
      answer: str(q.answer),
      explanation: str(q.analysis) || str(q.summary),
      based_on: uniq([...(q.reasoning_refs ?? []), ...(q.based_on ?? [])]).filter((id) => cite.has(id) || (quizIds.has(id) && id !== q.id)),
      spoiler: q.meta.spoiler,
    };
  });
  pw.pages.quiz = quiz;

  // ---- sources: only those referenced by included elements, card order ----
  const sources: PublicSource[] = srcOrder
    .filter((sid) => referenced.has(sid))
    .map((sid) => {
      const s = srcInfo.get(sid)!;
      return {
        source_id: sid,
        title: s.title || s.url,
        publisher: s.publisher,
        url: s.url,
        accessed: /^\d{4}-\d{2}-\d{2}/.test(s.fetched_at) ? s.fetched_at.slice(0, 10) : "",
        tier: (TIERS.has(s.tier) ? s.tier : "T5") as PublicSource["tier"],
        license: s.license,
      };
    });
  pw.sources = sources;

  // ---- gaps ----
  const gapSeen = new Set<string>();
  const gaps: PublicGap[] = [];
  for (const g of nkg.gaps ?? []) {
    const key = `${g.module}\u0000${g.reason}`;
    if (gapSeen.has(key)) continue;
    gapSeen.add(key);
    gaps.push({ module: g.module, aspect_label: ASPECT_LABELS[g.module] ?? ASPECT_LABELS.extra, reason: g.reason });
  }
  pw.gaps = gaps;

  // ---- header ----
  const work = inp.work ?? {};
  const title = str(work.title) || str(nkg.work.title);
  const aliases = uniq(
    (work.aliases ?? [])
      .filter((a) => a && a.attested === true)
      .map((a) => str(a.text))
      .filter((t) => t && t !== title),
  );
  const genreSlugs = new Set(inp.genreVocab.map((g) => g.slug));
  const creators = (nkg.work.creators ?? []).filter((c) => c && str(c.name)).map((c) => ({ name: str(c.name), role: strOrNull(c.role) }));
  const yearFromBib = /^(\d{4})/.exec(str(nkg.work.bibliographic?.first_release))?.[1];
  const allSpoilers: Spoiler[] = [];
  const walk = (n: PlotNode) => {
    allSpoilers.push(n.spoiler);
    n.children.forEach(walk);
  };
  trees.forEach(walk);
  for (const x of [...characters, ...relations, ...themes, ...contexts, ...iconic, ...interpretations, ...quiz, ...(matrix?.secrets ?? []), ...(timeline?.events ?? []), ...events, ...motives, ...arcs, ...worldRules, ...setups, ...emotionBeats]) allSpoilers.push(x.spoiler);
  pw.work = {
    selected_modules: nkg.work.module_selection.filter(m=>m.enabled).map(m=>m.module),
    work_id: str(work.work_id) || nkg.work.work_id,
    title,
    title_original: strOrNull(work.title_original),
    title_reading: strOrNull(work.title_reading),
    aliases_display: aliases,
    ...(work.kind || nkg.work.kind ? { kind: (work.kind || nkg.work.kind)! } : {}),
    medium: (MEDIA.has(nkg.work.medium) ? nkg.work.medium : MEDIA.has(String(work.medium)) ? work.medium : "other") as PublicWorkHeader["medium"],
    creators: creators.length ? creators : (work.creators ?? []).map((c) => ({ name: str(c), role: null })).filter((c) => c.name),
    genres: uniq((nkg.work.genres ?? []).filter((g) => genreSlugs.has(g))),
    tags: inp.tags.slice(0, MAX_TAGS),
    status: (STATUSES.has(nkg.work.bibliographic?.status) ? nkg.work.bibliographic.status : "unknown") as PublicWorkHeader["status"],
    first_release_year: typeof work.first_release_year === "number" ? work.first_release_year : yearFromBib ? Number(yearFromBib) : null,
    publisher: strOrNull(nkg.work.bibliographic?.publisher),
    coverage_label:
      (nkg.work.coverage ?? [])
        .map((c) => str(c?.label))
        .filter(Boolean)
        .join("・") || "全体",
    spoiler_max: maxSpoiler(...allSpoilers),
    has_matrix: matrix !== null,
    first_published_at: work.first_published_at ?? null,
    updated_at: work.updated_at ?? null,
  };

  const plotCount = trees.reduce((s, t) => s + size(t), 0);
  const stats: ProjectionStats = {
    elements_total: nkg.nodes.length + nkg.edges.length,
    elements_public: pubNodes.length + nkg.edges.filter((e) => eligible(e.id)).length,
    elements_included: included.size,
    characters: characters.length,
    relations: relations.length,
    trees: trees.length,
    plot_nodes: plotCount,
    matrix_secrets: matrix?.secrets.length ?? 0,
    matrix_holders: matrix?.holders.length ?? 0,
    matrix_cells: matrix?.cells.length ?? 0,
    timeline_events: timeline?.events.length ?? 0,
    themes: themes.length,
    contexts: contexts.length,
    iconic: iconic.length,
    interpretations: interpretations.length,
    quiz: quiz.length,
    factions: factions.length,
    events: events.length,
    motives: motives.length,
    arcs: arcs.length,
    world_rules: worldRules.length,
    setups: setups.length,
    emotion_beats: emotionBeats.length,
    orphan_motives_arcs: orphanMotivesArcs,
    sources_kept: sources.length,
    sources_total: srcInfo.size,
    gaps: gaps.length,
  };
  return { projection: pw, stats, chainDropout: computeChainDropout(nkg, inp.validation) };
}

function readWorkOrNull(workDir: string): Work | null {
  return existsSync(path.join(workDir, "work.json")) ? readWork(workDir) : null;
}

/** Stage: writes gen/projection.json (deterministic). */
export async function projectPublic(ctx: StageContext): Promise<StageResult> {
  const nkg = readNkg(ctx.workDir);
  const validation = readValidation(ctx.workDir);
  const { projection, stats, chainDropout } = buildProjection({
    nkg,
    validation,
    cards: readSourceCards(ctx.workDir),
    work: readWorkOrNull(ctx.workDir),
    tags: readFinalTags(ctx.workDir),
    genreVocab: loadGenreVocab(),
  });
  const problems = checkPublicWork(projection);
  if (problems.length) throw new Error(`S3 project: projection violates PublicWork shape: ${problems.slice(0, 5).join("; ")}`);
  // chain_dropout is an extra top-level key of the internal projection file. Readers (write, compose) pick
  // PublicWork fields explicitly and compose builds public.json field by field, so it never reaches public.json.
  const out = writeJson(ctx.workDir, GEN_FILES.projection, { ...projection, chain_dropout: chainDropout });
  const warnings: string[] = [];
  if (chainDropout.count > 0) warnings.push(`chain dropout: ${chainDropout.count} element(s) excluded because their root(s) are not public-eligible`);
  if (projection.work.kind !== "nonfiction" && !stats.characters) warnings.push("project: no public characters (figure A empty)");
  if (projection.work.kind !== "nonfiction" && !stats.trees) warnings.push("project: no public reverse-plot tree (figure B empty)");
  ctx.log(`s3.project: included=${stats.elements_included}/${stats.elements_total} chain_dropout=${chainDropout.count} chars=${stats.characters} rels=${stats.relations} trees=${stats.trees} matrix=${stats.matrix_secrets}x${stats.matrix_holders} sources=${stats.sources_kept}/${stats.sources_total}`);
  return {
    outputs: [out],
    metrics: { ...stats, chain_dropout: chainDropout.count, chain_dropout_roots: chainDropout.roots.length, spoiler_max: projection.work.spoiler_max, has_matrix: projection.work.has_matrix ? 1 : 0 },
    warnings,
  };
}
