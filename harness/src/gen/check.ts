/**
 * Runtime checker for `gen/public.json` against site/src/public-types.ts (PublicWork). A hand-written spec
 * mirrors the type: required keys, primitive types, enums, nullability — and NO extra keys anywhere.
 * Also a deep scan for internal fields / paths that must never reach the public file (§2.6).
 * Keep in sync with public-types.ts (the type is the contract; this file is its executable copy).
 */

type Spec =
  | "string"
  | "number"
  | "boolean"
  | { enum: readonly string[] }
  | { literal: string }
  | { array: Spec }
  | { object: Record<string, Spec> }
  | { nullable: Spec };

const S = "string" as const;
const N = "number" as const;
const B = "boolean" as const;
const nul = (s: Spec): Spec => ({ nullable: s });
const arr = (s: Spec): Spec => ({ array: s });
const obj = (o: Record<string, Spec>): Spec => ({ object: o });
const en = (...v: string[]): Spec => ({ enum: v });

const EPISTEMIC = en("canon", "consensus", "fan_theory", "sfsh_analysis");
const GRADE = en("A", "B", "C", "D");
const SPOILER = en("none", "mid", "ending");
const CAUSE_KIND = en("causes", "enables", "motivates", "prevents");
const elementBase = { id: S, epistemic: EPISTEMIC, grade: GRADE, spoiler: SPOILER, source_refs: arr(S) };

const TEXT_BLOCK = obj({ id: S, heading: nul(S), paragraphs: arr(S), spoiler: SPOILER, based_on: arr(S), epistemic: EPISTEMIC });

// PlotNode is recursive: children are checked by the same spec (see check()).
const PLOT_NODE_FIELDS: Record<string, Spec> = {
  id: S,
  kind: en("outcome", "why"),
  level: en("outcome", "direct", "factor", "root"),
  factor_kind: nul(en("political", "psychological", "social", "chance", "rule")),
  label: S,
  summary: nul(S),
  analysis: nul(S),
  epistemic: EPISTEMIC,
  grade: GRADE,
  spoiler: SPOILER,
  children: { array: { literal: "__plot__" } },
};

export const PUBLIC_WORK_SPEC: Spec = obj({
  schema: { literal: "sfsh-public/1" },
  work: obj({
    work_id: S,
    title: S,
    title_original: nul(S),
    title_reading: nul(S),
    aliases_display: arr(S),
    medium: en("novel", "manga", "anime", "film", "drama", "game", "other"),
    creators: arr(obj({ name: S, role: nul(S) })),
    genres: arr(S),
    tags: arr(S),
    status: en("completed", "ongoing", "unknown"),
    first_release_year: nul(N),
    publisher: nul(S),
    coverage_label: S,
    spoiler_max: SPOILER,
    has_matrix: B,
    first_published_at: nul(S),
    updated_at: nul(S),
  }),
  phases: arr(obj({ id: S, label: S, order: N })),
  viz: obj({
    relations: obj({
      characters: arr(obj({ ...elementBase, label: S, summary: nul(S), faction: nul(S), prominence: N })),
      relations: arr(
        obj({
          ...elementBase,
          from: S,
          to: S,
          kind: S,
          valence: en("positive", "negative", "ambivalent", "neutral"),
          phase_from: nul(S),
          phase_to: nul(S),
          changed_by_label: nul(S),
        }),
      ),
      factions: arr(obj({ id: S, label: S })),
    }),
    reverse_plot: obj({ trees: arr({ literal: "__plot__" }) }),
    matrix: nul(
      obj({
        secrets: arr(obj({ id: S, label: S, epistemic: EPISTEMIC, grade: GRADE, spoiler: SPOILER })),
        holders: arr(obj({ id: S, label: S, is_audience: B })),
        cells: arr(obj({ secret: S, holder: S, phase: S, state: en("unknown", "suspects", "misbelieves", "knows") })),
      }),
    ),
    timeline: nul(obj({ events: arr(obj({ id: S, label: S, story_order: N, disclosure_phase: nul(S), spoiler: SPOILER })) })),
  }),
  pages: obj({
    overview: arr(TEXT_BLOCK),
    figure_notes: obj({ relations: nul(TEXT_BLOCK), reverse_plot: nul(TEXT_BLOCK), matrix: nul(TEXT_BLOCK) }),
    themes: obj({
      intro: arr(TEXT_BLOCK),
      items: arr(obj({ ...elementBase, label: S, question: S, tension: S, values: arr(S), summary: nul(S), analysis: nul(S) })),
    }),
    context: obj({
      intro: arr(TEXT_BLOCK),
      items: arr(obj({ ...elementBase, kind: en("reception", "award", "influence", "symbolism", "controversy"), label: S, summary: nul(S), analysis: nul(S) })),
      iconic: arr(obj({ ...elementBase, label: S, why_famous: S, analysis: nul(S) })),
    }),
    interpretations: obj({
      intro: arr(TEXT_BLOCK),
      items: arr(obj({ id: S, topic: S, positions: arr(obj({ claim: S, epistemic: en("canon", "consensus", "fan_theory"), source_refs: arr(S) })), spoiler: SPOILER })),
    }),
    quiz: arr(
      obj({ id: S, quiz_type: en("causal", "motive", "counterfactual"), question: S, answer: S, explanation: S, based_on: arr(S), spoiler: SPOILER }),
    ),
  }),
  elements: obj({
    events: arr(
      obj({
        ...elementBase,
        label: S,
        summary: nul(S),
        story_order: nul(N),
        phase_ref: nul(S),
        caused_by: arr(obj({ event: S, kind: CAUSE_KIND })),
        leads_to: arr(obj({ event: S, kind: CAUSE_KIND })),
      }),
    ),
    motives: arr(
      obj({
        ...elementBase,
        owner: S,
        kind: en("goal", "fear", "belief", "conflict"),
        label: S,
        summary: nul(S),
        analysis: nul(S),
        phase_from: nul(S),
        phase_to: nul(S),
        drives: arr(S),
        conflicts_with: arr(S),
      }),
    ),
    arcs: arr(obj({ ...elementBase, character: S, arc_type: S, label: S, initial_state: S, final_state: S, summary: nul(S), analysis: nul(S), turns_at: arr(S) })),
    world_rules: arr(obj({ ...elementBase, kind: en("constraint", "ability", "institution"), label: S, summary: nul(S), consequence: S, constrains: arr(S) })),
    setups: arr(obj({ ...elementBase, label: S, meaning: S, pays_off: arr(S) })),
    emotion_beats: arr(obj({ ...elementBase, phase: S, emotion: S, intensity: N, label: S, summary: nul(S), evoked_by: arr(S) })),
  }),
  gaps: arr(obj({ module: S, aspect_label: S, reason: en("insufficient_sources", "conflicting_sources", "out_of_coverage") })),
  sources: arr(
    obj({ source_id: S, title: S, publisher: nul(S), url: S, accessed: S, tier: en("T1", "T2", "T3", "T4", "T5"), license: nul(S) }),
  ),
});

const PLOT_SPEC: Spec = { object: PLOT_NODE_FIELDS };

function check(v: unknown, spec: Spec, at: string, out: string[]): void {
  if (out.length > 200) return;
  if (spec === "string") {
    if (typeof v !== "string") out.push(`${at}: expected string`);
    return;
  }
  if (spec === "number") {
    if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${at}: expected number`);
    return;
  }
  if (spec === "boolean") {
    if (typeof v !== "boolean") out.push(`${at}: expected boolean`);
    return;
  }
  if ("literal" in spec) {
    if (spec.literal === "__plot__") return check(v, PLOT_SPEC, at, out);
    if (v !== spec.literal) out.push(`${at}: expected "${spec.literal}"`);
    return;
  }
  if ("enum" in spec) {
    if (typeof v !== "string" || !spec.enum.includes(v)) out.push(`${at}: expected one of ${spec.enum.join("|")}, got ${JSON.stringify(v)}`);
    return;
  }
  if ("nullable" in spec) {
    if (v === null) return;
    return check(v, spec.nullable, at, out);
  }
  if ("array" in spec) {
    if (!Array.isArray(v)) {
      out.push(`${at}: expected array`);
      return;
    }
    v.forEach((x, i) => check(x, spec.array, `${at}[${i}]`, out));
    return;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    out.push(`${at}: expected object`);
    return;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(spec.object)) {
    if (!(k in o)) out.push(`${at}.${k}: missing`);
    else check(o[k], spec.object[k], `${at}.${k}`, out);
  }
  for (const k of Object.keys(o)) if (!(k in spec.object)) out.push(`${at}.${k}: extra key`);
}

/** Shape problems of a PublicWork candidate (empty = conforms). */
export function checkPublicWork(v: unknown): string[] {
  const out: string[] = [];
  check(v, PUBLIC_WORK_SPEC, "$", out);
  return out;
}

/** Keys that must never appear in a public file. `claim` is allowed only as interpretations.items[].positions[].claim (contract field). */
export const FORBIDDEN_KEYS = [
  "excerpts",
  "excerpt",
  "claim",
  "claims",
  "claim_refs",
  "claim_ids",
  "provenance",
  "locator",
  "evidence",
  "authored_by",
  "reviewed_by",
  "review",
  "findings",
  "responses",
  "confidence",
  "basis",
  "raw_text_path",
  "content_hash",
  "public_eligible",
  "reasons",
  "model",
  "modelId",
  "model_id",
] as const;

const POSITION_CLAIM = /^\$\.pages\.interpretations\.items\[\d+\]\.positions\[\d+\]\.claim$/;

/** Deep scan: forbidden keys, local / research paths in any string. */
export function forbiddenContent(v: unknown): string[] {
  const out: string[] = [];
  const keys = new Set<string>(FORBIDDEN_KEYS);
  const walk = (x: unknown, at: string) => {
    if (typeof x === "string") {
      if (/research[\\/]+raw/i.test(x)) out.push(`${at}: mentions research/raw`);
      if (/(^|[\s"'(])[A-Za-z]:[\\/]/.test(x) || /[\\/]Users[\\/]/.test(x) || /file:\/\//i.test(x)) out.push(`${at}: looks like a local path`);
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((y, i) => walk(y, `${at}[${i}]`));
      return;
    }
    if (x && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        const p = `${at}.${k}`;
        if (keys.has(k) && !(k === "claim" && POSITION_CLAIM.test(p))) out.push(`${p}: forbidden key`);
        walk(y, p);
      }
    }
  };
  walk(v, "$");
  return out;
}
