/**
 * AMENDMENT 15 (BRIEF §14, 2026-11-23 19:14): requirement conformance — deterministic checks of the *shape* of a work
 * before it is published, after S4 autocheck.
 *
 * Only machine-countable requirements are judged (REQUIREMENTS 5.5):
 *   (a) synopsis_chars  the long synopsis reaches the lower bound of its scale target (3.2: film 8,000 / ≤13 eps 9,000 …)
 *   (b) coverage        the coverage goals of 1.3 on the NKG fact layer (events per phase, ending, main characters in
 *                       events) — the same measure that research/coverage.json records (research/coverage.ts)
 *   (c) figures         every selected module with a figure has that figure in the public projection
 *                       (M01 relations, M02 reverse plot, M05 knowledge matrix, M04 timeline)
 *   (d) regression      against the previous published version (works/<id>/releases/published.public.json): no figure
 *                       lost, public element count not down by more than `max_element_drop_ratio`
 *   (e) rights          A-1 / A-2 residual 0 (always enforce; autocheck already guarantees it)
 *
 * Content itself — angle, reading, analysis, voice, branching interpretations — is never judged here and never
 * steered by the repairs (P-1). Repairs only add what is missing (job/conform.ts).
 *
 * Each item has a mode in harness/config/conformance.json: enforce (not published until met; repaired up to
 * repair_max times, then "built, publish held") / warn (recorded, published) / off.
 */
import fs from "node:fs";
import path from "node:path";
import type { PlotNode, PublicWork, TextBlock } from "../../../site/src/public-types.ts";
import { isoLocal } from "../model/callLog.ts";
import { paths } from "../paths.ts";
import { synopsisTarget } from "../gen/synopsis.ts";
import { claimCoverage, factCoverage, type FactCoverage } from "../research/coverage.ts";
import { readClaims, writeJsonAtomic } from "../research/researchIo.ts";
import { readWork, rebuildIndex, writeWork } from "../works/store.ts";
import type { ConformanceHold } from "../works/types.ts";
import { renameSyncRetry } from "../util/fsRetry.ts";

// ------------------------------------------------------------------ config

export const CONFORMANCE_ITEMS = ["synopsis_chars", "coverage", "figures", "regression", "rights"] as const;
export type ConformanceItem = (typeof CONFORMANCE_ITEMS)[number];
export const CONFORMANCE_MODES = ["enforce", "warn", "off"] as const;
export type ConformanceMode = (typeof CONFORMANCE_MODES)[number];

export interface ConformanceConfig {
  items: Record<ConformanceItem, { mode: ConformanceMode; repair_max: number }>;
  regression: { max_element_drop_ratio: number };
}

/** Defaults and their reasons: REQUIREMENTS 5.5. */
export const DEFAULT_CONFORMANCE: ConformanceConfig = {
  items: {
    synopsis_chars: { mode: "enforce", repair_max: 2 },
    coverage: { mode: "warn", repair_max: 2 },
    figures: { mode: "warn", repair_max: 2 },
    regression: { mode: "enforce", repair_max: 2 },
    rights: { mode: "enforce", repair_max: 0 },
  },
  regression: { max_element_drop_ratio: 0.05 },
};

/** Under the test runner without an explicit config: everything warn (existing pipeline tests keep their call counts). */
const TEST_DEFAULT: ConformanceConfig = {
  items: {
    synopsis_chars: { mode: "warn", repair_max: 2 },
    coverage: { mode: "warn", repair_max: 2 },
    figures: { mode: "warn", repair_max: 2 },
    regression: { mode: "warn", repair_max: 2 },
    rights: { mode: "enforce", repair_max: 0 },
  },
  regression: { max_element_drop_ratio: 0.05 },
};

export function conformanceConfigPath(): string {
  return process.env.SFSH_CONFORMANCE_CONFIG || path.join(paths.root, "harness", "config", "conformance.json");
}

/** Strict: an unknown item / mode or an out-of-range number is an error (no silent fallback). */
export function parseConformanceConfig(raw: unknown, where = "conformance.json"): ConformanceConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const items = (o.items ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(items)) if (!(CONFORMANCE_ITEMS as readonly string[]).includes(k)) throw new Error(`${where}: unknown item "${k}" (allowed: ${CONFORMANCE_ITEMS.join(", ")})`);
  const out: ConformanceConfig = { items: { ...DEFAULT_CONFORMANCE.items }, regression: { ...DEFAULT_CONFORMANCE.regression } };
  for (const k of CONFORMANCE_ITEMS) {
    const v = items[k];
    if (v === undefined) continue;
    const e = v as Record<string, unknown>;
    const mode = e.mode ?? DEFAULT_CONFORMANCE.items[k].mode;
    if (!(CONFORMANCE_MODES as readonly unknown[]).includes(mode)) throw new Error(`${where}: items.${k}.mode must be one of ${CONFORMANCE_MODES.join("/")} (got ${JSON.stringify(mode)})`);
    const rm = e.repair_max ?? DEFAULT_CONFORMANCE.items[k].repair_max;
    if (typeof rm !== "number" || !Number.isInteger(rm) || rm < 0 || rm > 5) throw new Error(`${where}: items.${k}.repair_max must be an integer 0..5 (got ${JSON.stringify(rm)})`);
    out.items[k] = { mode: mode as ConformanceMode, repair_max: rm };
  }
  // (e) the rights check is the one fixed gate (C-2): it cannot be turned into warn / off here.
  if (out.items.rights.mode !== "enforce") throw new Error(`${where}: items.rights.mode must stay "enforce" (A-1 / A-2 are always on, REQUIREMENTS 5.1)`);
  const reg = (o.regression ?? {}) as Record<string, unknown>;
  if (reg.max_element_drop_ratio !== undefined) {
    const r = reg.max_element_drop_ratio;
    if (typeof r !== "number" || !(r >= 0 && r < 1)) throw new Error(`${where}: regression.max_element_drop_ratio must be a number 0..<1 (got ${JSON.stringify(r)})`);
    out.regression.max_element_drop_ratio = r;
  }
  return out;
}

export function loadConformanceConfig(): ConformanceConfig {
  if (process.env.NODE_TEST_CONTEXT && !process.env.SFSH_CONFORMANCE_CONFIG) return structuredClone(TEST_DEFAULT);
  const f = conformanceConfigPath();
  if (!fs.existsSync(f)) return structuredClone(DEFAULT_CONFORMANCE);
  return parseConformanceConfig(JSON.parse(fs.readFileSync(f, "utf8")), path.basename(f));
}

// ------------------------------------------------------------------ shape of a public work

export const FIGURES = ["relations", "reverse_plot", "matrix", "timeline"] as const;
export type FigureKey = (typeof FIGURES)[number];
/** Module → figure (REQUIREMENTS 2.4 / 6.4: figure A relations, B reverse plot, C matrix; M04 timeline). */
export const MODULE_FIGURE: Record<string, FigureKey> = { M01: "relations", M02: "reverse_plot", M05: "matrix", M04: "timeline" };
export const FIGURE_JA: Record<FigureKey, string> = { relations: "関係図", reverse_plot: "逆算図", matrix: "情報の非対称性マトリクス", timeline: "年表" };

/** Public element kinds, grouped by the NKG layer that authors them (for choosing a repair). */
export const FACT_KINDS = ["characters", "relations", "factions", "events", "matrix_secrets", "world_rules", "setups", "contexts"] as const;
export const INTERP_KINDS = ["plot_nodes", "motives", "arcs", "themes", "emotion_beats", "iconic", "interpretations", "quiz"] as const;

export interface PublicShape {
  /** distinct public element ids (figures + page items + element sections) */
  elements: number;
  by_kind: Record<string, number>;
  figures: Record<FigureKey, boolean>;
  synopsis: { chapters: number; chars: number } | null;
}

const len = (s: string | null | undefined) => [...(s ?? "")].length;
const blockChars = (b: TextBlock) => len(b.heading) + b.paragraphs.reduce((n, p) => n + len(p), 0);

/** Synopsis characters counted like gen/synopsis_report.json total_chars (intro + chapter headings + block headings + paragraphs). */
export function synopsisChars(pw: PublicWork): { chapters: number; chars: number } | null {
  const s = pw.pages?.synopsis;
  if (!s) return null;
  const intro = s.intro.reduce((n, b) => n + blockChars(b), 0);
  const chapters = s.chapters.reduce((n, c) => n + len(c.heading) + c.blocks.reduce((m, b) => m + blockChars(b), 0), 0);
  return { chapters: s.chapters.length, chars: intro + chapters };
}

export function publicShape(pw: PublicWork): PublicShape {
  const plot: PlotNode[] = [];
  const walk = (n: PlotNode) => {
    plot.push(n);
    n.children.forEach(walk);
  };
  pw.viz.reverse_plot.trees.forEach(walk);
  const kinds: Record<string, { id: string }[]> = {
    book_nodes: pw.book?.nodes ?? [],
    book_edges: pw.book?.edges ?? [],
    characters: pw.viz.relations.characters,
    relations: pw.viz.relations.relations,
    factions: pw.viz.relations.factions ?? [],
    plot_nodes: plot,
    matrix_secrets: pw.viz.matrix?.secrets ?? [],
    timeline_events: pw.viz.timeline?.events ?? [],
    events: pw.elements.events,
    motives: pw.elements.motives,
    arcs: pw.elements.arcs,
    world_rules: pw.elements.world_rules,
    setups: pw.elements.setups,
    emotion_beats: pw.elements.emotion_beats,
    themes: pw.pages.themes.items,
    contexts: pw.pages.context.items,
    iconic: pw.pages.context.iconic,
    interpretations: pw.pages.interpretations.items,
    quiz: pw.pages.quiz,
  };
  const ids = new Set<string>();
  const by_kind: Record<string, number> = {};
  for (const [k, xs] of Object.entries(kinds)) {
    by_kind[k] = xs.length;
    for (const x of xs) if (x && typeof x.id === "string") ids.add(x.id);
  }
  by_kind.trees = pw.viz.reverse_plot.trees.length;
  by_kind.matrix_cells = pw.viz.matrix?.cells.length ?? 0;
  return {
    elements: ids.size,
    by_kind,
    figures: {
      relations: pw.viz.relations.characters.length > 0 && pw.viz.relations.relations.length > 0,
      reverse_plot: pw.viz.reverse_plot.trees.length > 0,
      matrix: !!pw.viz.matrix && pw.viz.matrix.secrets.length > 0,
      timeline: !!pw.viz.timeline && pw.viz.timeline.events.length > 0,
    },
    synopsis: synopsisChars(pw),
  };
}

// ------------------------------------------------------------------ baseline (previous published version)

export const PUBLISHED_COPY = "releases/published.public.json";
export const PUBLISHED_META = "releases/published.meta.json";
export const HELD_FILE = "gen/public.held.json";
export const REPORT_FILE = "check/conformance.json";

export interface Baseline {
  pw: PublicWork;
  source: string;
  release_id: string | null;
  saved_at: string | null;
}

export function readBaseline(workDir: string): Baseline | null {
  const f = path.join(workDir, PUBLISHED_COPY);
  if (!fs.existsSync(f)) return null;
  let meta: { release_id?: string; saved_at?: string } = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(workDir, PUBLISHED_META), "utf8"));
  } catch {
    /* copy without meta */
  }
  return { pw: JSON.parse(fs.readFileSync(f, "utf8")) as PublicWork, source: PUBLISHED_COPY, release_id: meta.release_id ?? null, saved_at: meta.saved_at ?? null };
}

/** S6 publish: keep the published public.json of a work as the baseline of the next regression check. */
export function savePublishedCopy(workDir: string, releaseId: string, at: Date, note = "published"): PublicShape | null {
  const src = path.join(workDir, "gen", "public.json");
  if (!fs.existsSync(src)) return null;
  const text = fs.readFileSync(src, "utf8");
  const dst = path.join(workDir, PUBLISHED_COPY);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(`${dst}.tmp`, text, "utf8");
  renameSyncRetry(`${dst}.tmp`, dst);
  const shape = publicShape(JSON.parse(text) as PublicWork);
  writeJsonAtomic(path.join(workDir, PUBLISHED_META), { schema: "sfsh-published-copy/1", release_id: releaseId, saved_at: isoLocal(at), note, elements: shape.elements, figures: shape.figures, synopsis: shape.synopsis });
  return shape;
}

// ------------------------------------------------------------------ evaluation

export type RepairAction = "synopsis" | "refact" | "interp" | "gapfill";
export type ItemStatus = "pass" | "shortfall" | "not_measured" | "off";

export interface ItemResult {
  item: ConformanceItem;
  mode: ConformanceMode;
  status: ItemStatus;
  goal: string;
  measured: Record<string, unknown>;
  /** one Japanese line per shortfall (notices / ledger) */
  shortfalls: string[];
  /** repairs that could add what is missing (the loop decides what the scope allows) */
  actions: RepairAction[];
  note?: string;
}

export interface EvalInput {
  workDir: string;
  candidate: PublicWork;
  candidateKind: "public" | "projection";
  baseline: Baseline | null;
  cfg: ConformanceConfig;
  /** A-1 / A-2 residuals come from check/report.json of this run (false for an external candidate file) */
  rightsFromReport: boolean;
}

function readJsonOr<T>(file: string, dflt: T): T {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : dflt;
  } catch {
    return dflt;
  }
}

/** Enabled modules from nkg/nkg.json (work.module_selection). */
export function enabledModules(workDir: string): Set<string> {
  const nkg = readJsonOr<{ work?: { module_selection?: { module: string; enabled: boolean }[] } } | null>(path.join(workDir, "nkg", "nkg.json"), null);
  return new Set((nkg?.work?.module_selection ?? []).filter((m) => m.enabled).map((m) => m.module));
}

/** Fact-layer coverage of the current NKG (the measure research/coverage.json records after refact). */
export function currentFactCoverageOf(workDir: string): FactCoverage | null {
  const f = readJsonOr<{ drafts?: unknown[] } | null>(path.join(workDir, "nkg", "layers", "fact.json"), null);
  const p = readJsonOr<{ phases?: { id: string; label: string; scope?: string }[] } | null>(path.join(workDir, "nkg", "phases.json"), null);
  if (!f?.drafts || !p?.phases) return null;
  return factCoverage(f.drafts as never, p.phases);
}

function evalSynopsis(inp: EvalInput, mode: ConformanceMode): ItemResult {
  if (inp.candidate.work.kind === "nonfiction") return {item:"synopsis_chars",mode,status:"not_measured",goal:"非物語は要旨と論理要約",measured:{},shortfalls:[],actions:[],note:"物語のあらすじ字数は適用しない"};
  const target = synopsisTarget(inp.candidate);
  const s = synopsisChars(inp.candidate);
  const goal = `あらすじ ${target[0].toLocaleString("en")}字以上（規模別の目安 ${target[0].toLocaleString("en")}〜${target[1].toLocaleString("en")}字、REQUIREMENTS 3.2）`;
  if (!s) {
    if (inp.candidateKind === "projection") return { item: "synopsis_chars", mode, status: "not_measured", goal, measured: {}, shortfalls: [], actions: [], note: "候補が公開射影（本文なし）のため測れない" };
    return { item: "synopsis_chars", mode, status: "shortfall", goal, measured: { chars: 0, chapters: 0, target }, shortfalls: [`あらすじがない（目安 ${target[0]}〜${target[1]}字）`], actions: ["synopsis"] };
  }
  const ok = s.chars >= target[0];
  return {
    item: "synopsis_chars",
    mode,
    status: ok ? "pass" : "shortfall",
    goal,
    measured: { chars: s.chars, chapters: s.chapters, target, events_public: inp.candidate.elements.events.length },
    shortfalls: ok ? [] : [`あらすじ ${s.chars.toLocaleString("en")}字（目安 ${target[0].toLocaleString("en")}〜${target[1].toLocaleString("en")}字、不足 ${(target[0] - s.chars).toLocaleString("en")}字）`],
    actions: ok ? [] : ["synopsis"],
  };
}

function evalCoverage(inp: EvalInput, mode: ConformanceMode): ItemResult {
  const modules=enabledModules(inp.workDir);
  if (inp.candidate.work.kind === "nonfiction") {
    const missing=[...modules].filter(m=>m.startsWith("B")&&!(inp.candidate.book?.nodes.some(n=>n.module===m)));
    return {item:"coverage",mode,status:missing.length?"shortfall":"pass",goal:"選択したBKGモジュールの公開根拠がある",measured:{selected:[...modules],missing},shortfalls:missing.map(m=>`${m}: 公開可能な論点がない`),actions:missing.length?["refact"]:[]};
  }
  if (!modules.has("M03")) return {item:"coverage",mode,status:"not_measured",goal:"選択モジュールのカバレッジ",measured:{},shortfalls:[],actions:[],note:"出来事モジュール未選択"};
  const goal = "カバレッジ目標（1.3）: 各フェーズの出来事 3 以上・最後のフェーズ 3 以上かつ結末の出来事 1 以上・主要人物ごとの出来事 2 以上（事実層）";
  const fact = currentFactCoverageOf(inp.workDir);
  if (!fact) return { item: "coverage", mode, status: "not_measured", goal, measured: {}, shortfalls: [], actions: [], note: "nkg/layers/fact.json または nkg/phases.json がない" };
  let claims: ReturnType<typeof claimCoverage> | null = null;
  try {
    claims = claimCoverage(readClaims(inp.workDir));
  } catch {
    claims = null;
  }
  const claimKeys = new Set((claims?.shortfalls ?? []).map((s) => s.key));
  // The claims still lack this part → research (gapfill) is needed; the claims have it → the fact layer did not use it (refact).
  const needsResearch = fact.shortfalls.some((s) => (s.kind === "ending" ? claimKeys.has("ending") || claimKeys.has("bucket:end") : s.kind === "character" ? claimKeys.has(s.key) : claimKeys.size > 0 && [...claimKeys].some((k) => k.startsWith("bucket:"))));
  return {
    item: "coverage",
    mode,
    status: fact.met ? "pass" : "shortfall",
    goal,
    measured: {
      fact: { events: fact.events, phases: fact.phases, ending: fact.ending, main_characters: fact.main_characters, shortfall_keys: fact.shortfalls.map((s) => s.key) },
      claims: claims ? { met: claims.met, plot_claims: claims.plot_claims, shortfall_keys: claims.shortfalls.map((s) => s.key) } : null,
    },
    shortfalls: fact.shortfalls.map((s) => `カバレッジ: ${s.detail}`),
    actions: fact.met ? [] : needsResearch ? ["gapfill", "refact"] : ["refact"],
  };
}

function evalFigures(inp: EvalInput, mode: ConformanceMode, shape: PublicShape): ItemResult {
  const mods = enabledModules(inp.workDir);
  const want = Object.entries(MODULE_FIGURE).filter(([m]) => mods.has(m));
  const goal = `選択モジュールの図: ${want.map(([m, f]) => `${m}→${FIGURE_JA[f]}`).join("・") || "（図を持つモジュールの選択なし）"}`;
  if (!mods.size) return { item: "figures", mode, status: "not_measured", goal, measured: {}, shortfalls: [], actions: [], note: "nkg/nkg.json の module_selection がない" };
  const missing = want.filter(([, f]) => !shape.figures[f]);
  const bookMissing=[...mods].filter(m=>["B02","B03"].includes(m)&&!(inp.candidate.book?.edges.some(e=>{
    const nodes=inp.candidate.book!.nodes;
    return nodes.some(n=>n.id===e.from&&n.module===m)||nodes.some(n=>n.id===e.to&&n.module===m);
  })));
  const bookShort=bookMissing.map(m=>`図がない: ${m} を選択しているが論点間の接続がない`);
  const actions = new Set<RepairAction>();
  for (const [m] of missing) actions.add(m === "M02" ? "interp" : "refact");
  return {
    item: "figures",
    mode,
    status: missing.length || bookMissing.length ? "shortfall" : "pass",
    goal,
    measured: { enabled_modules: [...mods].sort(), figures: shape.figures, trees: shape.by_kind.trees, matrix_secrets: shape.by_kind.matrix_secrets, characters: shape.by_kind.characters, relations: shape.by_kind.relations },
    shortfalls: [...bookShort, ...missing.map(([m, f]) => `図がない: ${m} を選択しているが${FIGURE_JA[f]}が公開射影にない`)],
    actions: [...actions],
  };
}

function evalRegression(inp: EvalInput, mode: ConformanceMode, shape: PublicShape, base: PublicShape | null): ItemResult {
  const ratio = inp.cfg.regression.max_element_drop_ratio;
  const goal = `前の公開版から後退しない: 図を失わない・公開要素数の減少 ${Math.round(ratio * 100)}% 以内`;
  if (!base || !inp.baseline) return { item: "regression", mode, status: "not_measured", goal, measured: {}, shortfalls: [], actions: [], note: `前の公開版の写し（${PUBLISHED_COPY}）がない（初回公開、または A15 より前に公開されたまま保存されていない）` };
  const selected=enabledModules(inp.workDir);
  const lost = FIGURES.filter((f) => base.figures[f] && !shape.figures[f] && Object.entries(MODULE_FIGURE).some(([m,key])=>key===f&&selected.has(m)));
  const drop = base.elements > 0 ? (base.elements - shape.elements) / base.elements : 0;
  const deltas: Record<string, { before: number; after: number }> = {};
  for (const k of new Set([...Object.keys(base.by_kind), ...Object.keys(shape.by_kind)])) {
    const b = base.by_kind[k] ?? 0;
    const a = shape.by_kind[k] ?? 0;
    if (a !== b) deltas[k] = { before: b, after: a };
  }
  const shortfalls: string[] = [];
  if (drop > ratio) shortfalls.push(`公開要素数の後退: ${base.elements} → ${shape.elements}（${Math.round(drop * 1000) / 10}% 減、許容 ${Math.round(ratio * 100)}%）`);
  for (const f of lost) shortfalls.push(`図の後退: 前の公開版にあった${FIGURE_JA[f]}がない`);
  const dropped = Object.entries(deltas).filter(([, d]) => d.after < d.before).map(([k]) => k);
  const actions = new Set<RepairAction>();
  if (shortfalls.length) {
    if (dropped.some((k) => (FACT_KINDS as readonly string[]).includes(k) || k === "timeline_events")) actions.add("refact");
    if (dropped.some((k) => (INTERP_KINDS as readonly string[]).includes(k) || k === "trees")) actions.add("interp");
    if (!actions.size) actions.add("interp");
  }
  return {
    item: "regression",
    mode,
    status: shortfalls.length ? "shortfall" : "pass",
    goal,
    measured: {
      baseline: { source: inp.baseline.source, release_id: inp.baseline.release_id, elements: base.elements, figures: base.figures, synopsis: base.synopsis },
      candidate: { elements: shape.elements, figures: shape.figures, synopsis: shape.synopsis },
      element_drop_ratio: Math.round(drop * 1000) / 1000,
      figures_lost: lost,
      kind_deltas: deltas,
    },
    shortfalls,
    actions: [...actions],
  };
}

function evalRights(inp: EvalInput, mode: ConformanceMode): ItemResult {
  const goal = "A-1／A-2 の残り 0（5.1、常時有効）";
  if (!inp.rightsFromReport) return { item: "rights", mode, status: "not_measured", goal, measured: {}, shortfalls: [], actions: [], note: "外部の候補ファイル（この実行の check/report.json がない）" };
  const r = readJsonOr<{ a1?: { residual_after_fix?: number; detected?: unknown[] }; a2?: { residual_after_fix?: number; detected?: unknown[] } } | null>(path.join(inp.workDir, "check", "report.json"), null);
  if (!r) return { item: "rights", mode, status: "shortfall", goal, measured: {}, shortfalls: ["自動確認（A-1／A-2）の記録 check/report.json がない"], actions: [] };
  const a1 = r.a1?.residual_after_fix ?? 0;
  const a2 = r.a2?.residual_after_fix ?? 0;
  return {
    item: "rights",
    mode,
    status: a1 + a2 === 0 ? "pass" : "shortfall",
    goal,
    measured: { a1_detected: r.a1?.detected?.length ?? 0, a1_residual: a1, a2_detected: r.a2?.detected?.length ?? 0, a2_residual: a2 },
    shortfalls: a1 + a2 === 0 ? [] : [`A-1／A-2 の残り ${a1 + a2}`],
    actions: [],
  };
}

export interface Evaluation {
  items: ItemResult[];
  shape: PublicShape;
  baseline_shape: PublicShape | null;
}

export function evaluateConformance(inp: EvalInput): Evaluation {
  const shape = publicShape(inp.candidate);
  const base = inp.baseline ? publicShape(inp.baseline.pw) : null;
  const items: ItemResult[] = [];
  for (const item of CONFORMANCE_ITEMS) {
    const mode = inp.cfg.items[item].mode;
    if (mode === "off") {
      items.push({ item, mode, status: "off", goal: "", measured: {}, shortfalls: [], actions: [] });
      continue;
    }
    items.push(
      item === "synopsis_chars"
        ? evalSynopsis(inp, mode)
        : item === "coverage"
          ? evalCoverage(inp, mode)
          : item === "figures"
            ? evalFigures(inp, mode, shape)
            : item === "regression"
              ? evalRegression(inp, mode, shape, base)
              : evalRights(inp, mode),
    );
  }
  return { items, shape, baseline_shape: base };
}

export const blockingOf = (items: ItemResult[]) => items.filter((i) => i.mode === "enforce" && i.status === "shortfall");

// ------------------------------------------------------------------ report

export interface RepairRun {
  attempt: number;
  action: RepairAction;
  items: ConformanceItem[];
  hints: unknown;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  stages: { stage: string; ok: boolean; duration_ms: number; metrics?: Record<string, number | string>; error?: string }[];
  ok: boolean;
}

export interface ConformanceReport {
  schema: "sfsh-conformance/1";
  work_id: string;
  job_id: string;
  scope: "job" | "regen" | "check";
  checked_at: string;
  config: ConformanceConfig;
  candidate: { kind: "public" | "projection"; source: string };
  baseline: { source: string; release_id: string | null; saved_at: string | null } | null;
  /** results of the first check (before any repair) */
  initial: ItemResult[];
  /** results of the last check */
  items: ItemResult[];
  shape: { candidate: PublicShape; baseline: PublicShape | null };
  repairs: RepairRun[];
  repair_attempts: Partial<Record<ConformanceItem, number>>;
  /** enforce items whose shortfall the loop could not repair (and why) */
  unrepairable: { item: ConformanceItem; reason: string }[];
  /** pass = everything measured met; warn = only warn items short; held = an enforce item still short; in_progress */
  outcome: "pass" | "warn" | "held" | "in_progress";
  blocking: ConformanceItem[];
  notice: string[];
}

export const ITEM_JA: Record<ConformanceItem, string> = { synopsis_chars: "あらすじの字数", coverage: "カバレッジ", figures: "選択モジュールの図", regression: "前の公開版からの後退", rights: "A-1／A-2" };

export function outcomeOf(items: ItemResult[]): ConformanceReport["outcome"] {
  if (blockingOf(items).length) return "held";
  return items.some((i) => i.status === "shortfall") ? "warn" : "pass";
}

/** Notice lines (completion notice / ledger): one summary line + the shortfalls. */
export function conformanceNotice(r: Pick<ConformanceReport, "outcome" | "items" | "repairs" | "unrepairable" | "work_id">): string[] {
  const short = r.items.filter((i) => i.status === "shortfall");
  const rep = r.repairs.length ? `、修復 ${r.repairs.length} 回（${r.repairs.map((x) => `${x.action}${x.ok ? "" : "×"}`).join("・")}）` : "";
  const head =
    r.outcome === "held"
      ? `要件適合: 公開保留（enforce の不足 ${blockingOf(r.items).map((i) => ITEM_JA[i.item]).join("・")}${rep}）。前の公開版のまま。解除: sfsh release ${r.work_id}`
      : r.outcome === "warn"
        ? `要件適合: 記録して公開（warn の不足 ${short.map((i) => ITEM_JA[i.item]).join("・")}${rep}）`
        : `要件適合: すべて適合${rep}`;
  const lines = [head, ...short.flatMap((i) => i.shortfalls.map((s) => `${i.mode === "enforce" ? "[enforce]" : "[warn]"} ${s}`))];
  for (const u of r.unrepairable) lines.push(`修復できない不足（${ITEM_JA[u.item]}）: ${u.reason}`);
  return lines.slice(0, 8);
}

export function writeReport(workDir: string, r: ConformanceReport): string {
  writeJsonAtomic(path.join(workDir, REPORT_FILE), r);
  return REPORT_FILE;
}

export function readReport(workDir: string): ConformanceReport | null {
  return readJsonOr<ConformanceReport | null>(path.join(workDir, REPORT_FILE), null);
}

// ------------------------------------------------------------------ hold / release (work level)

function mirrorWork(workDir: string, pw: PublicWork | null, hold: ConformanceHold | null, history: { event: string; job_id: string | null; detail: string; actor?: string }, now: Date): void {
  if (!fs.existsSync(path.join(workDir, "work.json"))) return;
  const w = readWork(workDir);
  if (pw) {
    w.status = pw.work.status;
    w.coverage_label = pw.work.coverage_label;
    w.spoiler_max = pw.work.spoiler_max;
    w.has_matrix = pw.work.has_matrix;
    w.updated_at = pw.work.updated_at;
  }
  w.conformance_hold = hold;
  w.history = [...(w.history ?? []), { at: isoLocal(now), event: history.event, job_id: history.job_id, detail: history.detail, ...(history.actor ? { actor: history.actor } : {}) }];
  writeWork(workDir, w);
  rebuildIndex(path.dirname(workDir));
}

/**
 * Held: gen/public.json (the candidate) → gen/public.held.json; gen/public.json ← the previous published version
 * (or removed when there is none, so the build leaves the work out). Every later build / publish therefore carries the
 * previous version until `sfsh release` (or a later conforming run).
 */
export function holdCandidate(workDir: string, report: ConformanceReport, now: Date): ConformanceHold {
  const pub = path.join(workDir, "gen", "public.json");
  const held = path.join(workDir, HELD_FILE);
  if (fs.existsSync(pub)) {
    if (fs.existsSync(held)) fs.rmSync(held);
    renameSyncRetry(pub, held);
  }
  const base = readBaseline(workDir);
  if (base) {
    fs.copyFileSync(path.join(workDir, PUBLISHED_COPY), `${pub}.tmp`);
    renameSyncRetry(`${pub}.tmp`, pub);
  }
  const hold: ConformanceHold = {
    job_id: report.job_id,
    at: isoLocal(now),
    items: report.blocking,
    shortfalls: report.items.filter((i) => report.blocking.includes(i.item)).flatMap((i) => i.shortfalls),
    report: REPORT_FILE,
    public_json: base ? "previous_published" : "absent",
  };
  mirrorWork(workDir, base?.pw ?? null, hold, { event: "conformance_hold", job_id: report.job_id, detail: `publish held: ${hold.items.join(",")}; candidate kept in ${HELD_FILE}; gen/public.json = ${hold.public_json}` }, now);
  return hold;
}

/** A conforming run after a hold: the stale held candidate is dropped and the hold cleared. */
export function clearHold(workDir: string, jobId: string, now: Date): boolean {
  const held = path.join(workDir, HELD_FILE);
  let had = false;
  if (fs.existsSync(held)) {
    fs.rmSync(held);
    had = true;
  }
  if (fs.existsSync(path.join(workDir, "work.json"))) {
    const w = readWork(workDir);
    if (w.conformance_hold) {
      had = true;
      mirrorWork(workDir, null, null, { event: "conformance_cleared", job_id: jobId, detail: "a later run conformed; the earlier held candidate was dropped" }, now);
    }
  }
  return had;
}

/** `sfsh release <work_id>` on a conformance hold: the held candidate becomes gen/public.json (published by the next publish). */
export function releaseConformanceHold(workDir: string, actor: string, reason: string | null, now: Date): { released: boolean; detail: string } {
  const w = fs.existsSync(path.join(workDir, "work.json")) ? readWork(workDir) : null;
  const held = path.join(workDir, HELD_FILE);
  if (!w?.conformance_hold && !fs.existsSync(held)) return { released: false, detail: "no conformance hold" };
  if (!fs.existsSync(held)) {
    mirrorWork(workDir, null, null, { event: "conformance_release", job_id: w?.conformance_hold?.job_id ?? null, detail: `hold cleared; no held candidate file${reason ? `; reason: ${reason}` : ""}`, actor }, now);
    return { released: true, detail: "conformance hold cleared (no held candidate file; gen/public.json unchanged)" };
  }
  const pub = path.join(workDir, "gen", "public.json");
  const pw = JSON.parse(fs.readFileSync(held, "utf8")) as PublicWork;
  if (fs.existsSync(pub)) fs.rmSync(pub);
  renameSyncRetry(held, pub);
  const items = w?.conformance_hold?.items?.join(",") ?? "?";
  mirrorWork(workDir, pw, null, { event: "conformance_release", job_id: w?.conformance_hold?.job_id ?? null, detail: `conformance hold released by the owner (${items}); ${HELD_FILE} → gen/public.json; published by the next publish${reason ? `; reason: ${reason}` : ""}`, actor }, now);
  return { released: true, detail: `conformance hold released (${items}): ${HELD_FILE} → gen/public.json` };
}

// ------------------------------------------------------------------ ledger

export function ledgerPath(): string | null {
  if (process.env.SFSH_LEDGER_PATH) return process.env.SFSH_LEDGER_PATH;
  if (process.env.NODE_TEST_CONTEXT) return null;
  return path.join(paths.root, "logs", "LEDGER.md");
}

/** One `- CONFORMANCE …` line (held runs, so the shortfall shows in the ledger as well as the notice). */
export function appendConformanceLedger(r: ConformanceReport, now: Date): string | null {
  const f = ledgerPath();
  const line = `- CONFORMANCE ${isoLocal(now)} | work=${r.work_id} | job=${r.job_id} | scope=${r.scope} | outcome=${r.outcome} | blocking=${r.blocking.join(",") || "none"} | repairs=${r.repairs.length} | ${r.items
    .filter((i) => i.status === "shortfall")
    .flatMap((i) => i.shortfalls)
    .join(" / ")
    .slice(0, 400)} | report=works/${r.work_id}/${REPORT_FILE}${r.outcome === "held" ? ` | release: sfsh release ${r.work_id}` : ""}`;
  if (!f) return line;
  fs.appendFileSync(f, `${line}\n`, "utf8");
  return line;
}
