import fs from "node:fs";
import path from "node:path";
import type { Claim } from "./claimTypes.ts";
import { readJsonFile, writeJsonAtomic } from "./researchIo.ts";

/**
 * AMENDMENT 12: coverage-driven research. Deterministic coverage measures (no model judgement, REQUIREMENTS 1.2-3)
 * computed (a) from the active claims during S1 and (b) from the NKG fact layer after S2 `fact`. Each unmet goal
 * becomes a shortfall with a short description used as the target of one narrow follow-up search.
 * Goals are advisory targets: unmet goals are recorded as shortfalls, never a stop condition (P-1).
 */

/** [暫定, A12] coverage goals. */
export const COVERAGE_GOALS = {
  /** event-granular (plot) claims per story bucket */
  plotPerBucket: { early: 6, middle: 8, end: 6 },
  /** per-unit check only when the work has 2..unitsMax numbered units (episodes / chapters) */
  unitsMax: 60,
  /** main characters: up to this many, each mentioned by at least mainMinMentions active claims */
  mainCharacters: 6,
  mainMinMentions: 3,
  /** plot claims per main character, plus one claim about their late state (end phase / ending spoiler / M07 / M02) */
  charPlotMin: 3,
  /** ending: canon claims with spoiler "ending", and canon M02 claims (how / why it ended) */
  endingSpoilerMin: 4,
  endingM02Min: 1,
  /** fact layer: Events per phase, Events in the last phase, Events mentioning each main character */
  factEventsPerPhase: 3,
  factEventsLastPhase: 3,
  factCharEventsMin: 2,
} as const;

export type Bucket = "early" | "middle" | "end";
export const BUCKETS: Bucket[] = ["early", "middle", "end"];
const BUCKET_JA: Record<Bucket, string> = { early: "序盤", middle: "中盤", end: "終盤・結末" };

export interface CoverageShortfall {
  /** stable key, e.g. "bucket:end", "units:7-9", "character:佐倉杏子", "ending", "phase:ph3", "aspect:M09" */
  key: string;
  kind: "bucket" | "units" | "character" | "ending" | "phase" | "aspect";
  /** what is missing, in words (the target of one narrow follow-up search) */
  target: string;
  /** aspects the follow-up selections must carry */
  aspects: string[];
  /** measured value vs goal */
  detail: string;
  hints?: string[];
}

export interface ClaimCoverage {
  plot_claims: number;
  buckets: Record<Bucket, number>;
  units: { total: number | null; basis: "bibliographic" | "story_unit" | null; word: string; covered: number[]; missing: number[] };
  main_characters: { name: string; mentions: number; plot_claims: number; late_state: boolean }[];
  ending: { spoiler_ending: number; m02_canon: number; plot_end: number };
  met: boolean;
  shortfalls: CoverageShortfall[];
}

// ------------------------------------------------------------------ helpers

const isPlot = (c: Claim) => c.status === "active" && (c.aspects ?? []).includes("plot") && c.epistemic !== "fan_theory";

export function normName(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\s・=＝·.\-‐（）()「」『』]/g, "")
    .toLowerCase();
}

/** Same person when one normalized name contains the other (≥2 chars), e.g. "まどか" ⊂ "鹿目まどか". */
export function sameName(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  if (x.length < 2 || y.length < 2) return x === y && x.length > 0;
  return x.includes(y) || y.includes(x);
}

function claimNames(c: Claim): string[] {
  return c.characters ?? [];
}

/** Does the claim involve `name`? (characters field first, then the text) */
export function mentions(c: Claim, name: string): boolean {
  if (claimNames(c).some((n) => sameName(n, name))) return true;
  const n = normName(name);
  return n.length >= 2 && normName(c.text).includes(n);
}

/** Total units from bibliographic claims ("全12話", "全19章", "全6巻") or the largest stated story_unit. */
export function unitsTotal(claims: Claim[]): { total: number | null; basis: ClaimCoverage["units"]["basis"]; word: string } {
  const active = claims.filter((c) => c.status === "active");
  const counts = new Map<string, number>();
  for (const c of active) {
    if (!(c.aspects ?? []).includes("bibliographic") && !(c.aspects ?? []).includes("plot")) continue;
    for (const m of c.text.normalize("NFKC").matchAll(/全\s*(\d{1,3})\s*(話|章|回)/g)) {
      const k = `${m[1]}|${m[2] === "回" ? "話" : m[2]}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) {
    const [n, word] = best[0].split("|");
    const total = Number(n);
    if (total >= 2 && total <= COVERAGE_GOALS.unitsMax) return { total, basis: "bibliographic", word: word! };
  }
  const units = new Set(active.filter(isPlot).map((c) => c.story_unit).filter((u): u is number => typeof u === "number" && u > 0));
  if (units.size >= 3) {
    const max = Math.max(...units);
    if (max <= COVERAGE_GOALS.unitsMax) return { total: max, basis: "story_unit", word: "話" };
  }
  return { total: null, basis: null, word: "話" };
}

function bucketOf(c: Claim, total: number | null): Bucket | null {
  if (c.phase_hint === "early" || c.phase_hint === "middle" || c.phase_hint === "end") return c.phase_hint;
  if (total && typeof c.story_unit === "number" && c.story_unit > 0) {
    const r = c.story_unit / total;
    return r <= 1 / 3 ? "early" : r <= 2 / 3 ? "middle" : "end";
  }
  return null;
}

/** Ranges of consecutive numbers: [7,8,9,12] → [[7,9],[12,12]]. */
export function ranges(xs: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && x === last[1] + 1) last[1] = x;
    else out.push([x, x]);
  }
  return out;
}

/** Main characters: name clusters over the active claims' `characters`, ranked by the number of claims. */
export function mainCharacters(claims: Claim[], max: number = COVERAGE_GOALS.mainCharacters, minMentions: number = COVERAGE_GOALS.mainMinMentions): { name: string; mentions: number }[] {
  const active = claims.filter((c) => c.status === "active");
  const clusters: { forms: Map<string, number>; claims: Set<string> }[] = [];
  for (const c of active) {
    for (const raw of new Set(claimNames(c))) {
      const name = raw.trim();
      if (normName(name).length < 1) continue;
      let cl = clusters.find((k) => [...k.forms.keys()].some((f) => sameName(f, name)));
      if (!cl) {
        cl = { forms: new Map(), claims: new Set() };
        clusters.push(cl);
      }
      cl.forms.set(name, (cl.forms.get(name) ?? 0) + 1);
      cl.claims.add(c.claim_id);
    }
  }
  return clusters
    .map((k) => {
      // representative: the most frequent form (ties → the longer, i.e. fuller, name)
      const name = [...k.forms.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]![0];
      return { name, mentions: k.claims.size };
    })
    .filter((x) => x.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, max);
}

// ------------------------------------------------------------------ claim coverage (S1)

export function claimCoverage(claims: Claim[]): ClaimCoverage {
  const g = COVERAGE_GOALS;
  const active = claims.filter((c) => c.status === "active");
  const plot = active.filter(isPlot);
  const u = unitsTotal(claims);
  const buckets: Record<Bucket, number> = { early: 0, middle: 0, end: 0 };
  for (const c of plot) {
    const b = bucketOf(c, u.total);
    if (b) buckets[b]++;
  }
  const covered = new Set(plot.map((c) => c.story_unit).filter((x): x is number => typeof x === "number" && x > 0 && (!u.total || x <= u.total)));
  const missing = u.total ? Array.from({ length: u.total }, (_, i) => i + 1).filter((n) => !covered.has(n)) : [];

  const mains = mainCharacters(claims).map((m) => {
    const plotN = plot.filter((c) => mentions(c, m.name)).length;
    const late = active.some((c) => mentions(c, m.name) && (c.phase_hint === "end" || c.spoiler === "ending" || (c.aspects ?? []).some((a) => a === "M07" || a === "M02")));
    return { name: m.name, mentions: m.mentions, plot_claims: plotN, late_state: late };
  });
  const canon = active.filter((c) => c.epistemic === "canon");
  const ending = {
    spoiler_ending: canon.filter((c) => c.spoiler === "ending").length,
    m02_canon: canon.filter((c) => (c.aspects ?? []).includes("M02")).length,
    plot_end: buckets.end,
  };

  const shortfalls: CoverageShortfall[] = [];
  if (ending.spoiler_ending < g.endingSpoilerMin || ending.m02_canon < g.endingM02Min) {
    shortfalls.push({
      key: "ending",
      kind: "ending",
      target: `結末（${u.total ? `最終${u.word}を含む終盤` : "最後の局面"}）で何が起き、物語がどう決着したか（主要人物それぞれの最後の状態を含む）`,
      aspects: ["plot", "M02"],
      detail: `結末の canon claim ${ending.spoiler_ending}（目標 ${g.endingSpoilerMin}）、M02 canon ${ending.m02_canon}（目標 ${g.endingM02Min}）`,
      hints: ["結末 ネタバレ", "最終回 あらすじ", "ending explained"],
    });
  }
  for (const b of ["end", "middle", "early"] as Bucket[]) {
    if (buckets[b] < g.plotPerBucket[b]) {
      shortfalls.push({
        key: `bucket:${b}`,
        kind: "bucket",
        target: `物語の${BUCKET_JA[b]}の出来事の連なり（誰が何をして、どうなったか）`,
        aspects: ["plot"],
        detail: `${BUCKET_JA[b]}の粗筋 claim ${buckets[b]}（目標 ${g.plotPerBucket[b]}）`,
      });
    }
  }
  if (u.total) {
    // later units first (the ending side is the usual gap)
    for (const [a, b] of ranges(missing).reverse()) {
      const label = a === b ? `第${a}${u.word}` : `第${a}〜${b}${u.word}`;
      shortfalls.push({ key: `units:${a}-${b}`, kind: "units", target: `${label}の出来事（あらすじ）`, aspects: ["plot"], detail: `${label}の粗筋 claim 0（全${u.total}${u.word}）`, hints: [`${label} あらすじ`] });
    }
  }
  for (const m of mains) {
    if (m.plot_claims < g.charPlotMin || !m.late_state) {
      shortfalls.push({
        key: `character:${normName(m.name)}`,
        kind: "character",
        target: `人物「${m.name}」の物語上の動き（登場から最後の状態まで）`,
        aspects: ["plot", "M07"],
        detail: `「${m.name}」の粗筋 claim ${m.plot_claims}（目標 ${g.charPlotMin}）、終盤の状態 ${m.late_state ? "あり" : "なし"}`,
      });
    }
  }
  return { plot_claims: plot.length, buckets, units: { ...u, covered: [...covered].sort((a, b) => a - b), missing }, main_characters: mains, ending, met: shortfalls.length === 0, shortfalls };
}

// ------------------------------------------------------------------ fact-layer coverage (after S2 fact)

interface DraftLike {
  _type: string;
  id: string;
  label?: unknown;
  summary?: unknown;
  phase_ref?: unknown;
  spoiler?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface FactCoverage {
  phases: { id: string; label: string; events: number }[];
  events: number;
  main_characters: { id: string; name: string; events: number }[];
  ending: { last_phase_events: number; ending_events: number };
  met: boolean;
  shortfalls: CoverageShortfall[];
}

export function factCoverage(drafts: DraftLike[], phases: { id: string; label: string; scope?: string }[]): FactCoverage {
  const g = COVERAGE_GOALS;
  const events = drafts.filter((d) => d._type === "Event");
  const chars = drafts.filter((d) => d._type === "Character");
  const text = (d: DraftLike) => `${String(d.label ?? "")} ${String(d.summary ?? "")}`;
  const perPhase = phases.map((p) => ({ id: p.id, label: p.label, scope: p.scope ?? "", events: events.filter((e) => e.phase_ref === p.id).length }));
  const relCount = (id: string) => drafts.filter((d) => d._type === "Relation" && (d.from === id || d.to === id)).length;
  const charRows = chars
    .map((c) => {
      const name = String(c.label ?? "");
      const n = normName(name);
      // full name, or (for names of 3+ chars) the family-name part or the given-name part as written in event text
      const hit = (t: string) => t.includes(n) || (n.length >= 3 && (t.includes(n.slice(0, 2)) || t.includes(n.slice(-2))));
      const evs = n.length >= 1 ? events.filter((e) => hit(normName(text(e)))).length : 0;
      return { id: c.id, name, events: evs, weight: evs + relCount(c.id) };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, g.mainCharacters);
  const last = perPhase[perPhase.length - 1];
  const ending = { last_phase_events: last?.events ?? 0, ending_events: events.filter((e) => e.spoiler === "ending").length };

  const shortfalls: CoverageShortfall[] = [];
  if (ending.last_phase_events < g.factEventsLastPhase || ending.ending_events === 0) {
    shortfalls.push({
      key: "ending",
      kind: "ending",
      target: `結末（最後の局面${last ? `「${last.label}」` : ""}）で何が起き、物語がどう決着したか`,
      aspects: ["plot", "M02"],
      detail: `最後のフェーズの出来事 ${ending.last_phase_events}（目標 ${g.factEventsLastPhase}）、結末の出来事 ${ending.ending_events}`,
      hints: ["結末 ネタバレ", "最終回 あらすじ"],
    });
  }
  for (const p of [...perPhase].reverse()) {
    if (p.events < g.factEventsPerPhase) {
      shortfalls.push({ key: `phase:${p.id}`, kind: "phase", target: `物語の局面「${p.label}」${p.scope ? `（${p.scope}）` : ""}の出来事の連なり`, aspects: ["plot"], detail: `フェーズ ${p.id}「${p.label}」の出来事 ${p.events}（目標 ${g.factEventsPerPhase}）` });
    }
  }
  for (const c of charRows) {
    if (c.events < g.factCharEventsMin) {
      shortfalls.push({ key: `character:${normName(c.name)}`, kind: "character", target: `人物「${c.name}」の物語上の動き（登場から最後の状態まで）`, aspects: ["plot", "M07"], detail: `「${c.name}」が出てくる出来事 ${c.events}（目標 ${g.factCharEventsMin}）` });
    }
  }
  return {
    phases: perPhase.map(({ id, label, events: n }) => ({ id, label, events: n })),
    events: events.length,
    main_characters: charRows.map(({ id, name, events: n }) => ({ id, name, events: n })),
    ending,
    met: shortfalls.length === 0,
    shortfalls,
  };
}

// ------------------------------------------------------------------ research/coverage.json

export const COVERAGE_FILE = "research/coverage.json";

export interface CoverageRecord {
  at: string;
  job_id: string;
  stage: string;
  /** "detect" = a measurement; "round" = one targeted follow-up round */
  event: "detect" | "round";
  round?: number;
  coverage?: ClaimCoverage | FactCoverage;
  targets?: { key: string; target: string; searches: number; selected: number; fetched: number; gets: number }[];
  new_sources?: number;
  new_plot_claims?: number;
  new_active_claims?: number;
  budget?: { searches: number; fetches: number; limits: string };
  stopped_because?: string;
}

export function appendCoverage(workDir: string, rec: CoverageRecord): void {
  const file = path.join(workDir, COVERAGE_FILE);
  const all = readJsonFile<CoverageRecord[]>(file, []);
  all.push(rec);
  writeJsonAtomic(file, all);
}

export function readCoverage(workDir: string): CoverageRecord[] {
  const file = path.join(workDir, COVERAGE_FILE);
  return fs.existsSync(file) ? readJsonFile<CoverageRecord[]>(file, []) : [];
}
