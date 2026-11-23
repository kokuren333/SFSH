/** Small, valid NKG fixtures for tests (no network, no real work data). */
import { computeConfidence } from "./confidence.ts";
import type { Epistemic, Meta, ModelName, Nkg, NkgSource, ReviewState } from "./types.ts";

export const FIXTURE_SOURCES: NkgSource[] = [
  { source_id: "s000000001", url: "https://pub.example/work", title: "公式", publisher: "版元", tier: "T1", site_key: "pub.example", license: null, fetched_at: "2026-11-23T10:00:00+09:00" },
  { source_id: "s000000002", url: "https://wiki.example/work", title: "事典", publisher: "事典", tier: "T3", site_key: "wiki.example", license: "CC BY-SA 4.0", fetched_at: "2026-11-23T10:00:00+09:00" },
  { source_id: "s000000003", url: "https://fan.example/work", title: "ファン", publisher: "個人", tier: "T4", site_key: "fan.example", license: null, fetched_at: "2026-11-23T10:00:00+09:00" },
];

export function fixtureMeta(
  sourceIds: string[],
  opts: { epistemic?: Epistemic; authored?: ModelName; review?: ReviewState; phase?: string | null; support?: "direct" | "inferred" } = {},
): Meta {
  const provenance = sourceIds.map((s) => ({ source_id: s, locator: "claim:c0001", support: opts.support ?? ("direct" as const) }));
  const byId = new Map(FIXTURE_SOURCES.map((s) => [s.source_id, s] as const));
  const authored = opts.authored ?? "luna";
  const review = opts.review ?? "agreed";
  return {
    provenance,
    confidence: computeConfidence(provenance, byId, review),
    epistemic: opts.epistemic ?? "canon",
    coverage_ref: "全体",
    phase_ref: opts.phase === undefined ? null : opts.phase,
    spoiler: "none",
    authored_by: authored,
    reviewed_by: authored === "luna" ? "haiku" : "luna",
    review,
  };
}

export function fixtureNkg(): Nkg {
  const T1 = ["s000000001"];
  return {
    schema_version: "1.0",
    work: {
      work_id: "novel-test-work-2000",
      title: "試験作品",
      title_alt: [],
      creators: [{ name: "作者甲", role: "著者" }],
      medium: "novel",
      bibliographic: { publisher: "版元", first_release: "2000", status: "completed", source_ids: T1 },
      genres: ["mystery"],
      coverage: [{ unit: "whole", from: null, to: null, label: "全体" }],
      publish_mode: "Public",
      rights: { state: "unchecked", copyright_status: "in_copyright", holder_policy_note: "", source_ids: [] },
      module_selection: [{ module: "M01", weight: 1, enabled: true, reason: "always_on" }],
      phases: [
        { id: "ph1", label: "序盤", order: 1 },
        { id: "ph2", label: "中盤", order: 2 },
        { id: "ph3", label: "結末", order: 3 },
      ],
    },
    sources: FIXTURE_SOURCES,
    nodes: [
      { id: "ch01", type: "Character", module: "M01", label: "人物甲", based_on: [], meta: fixtureMeta(T1) },
      { id: "ch02", type: "Character", module: "M01", label: "人物乙", based_on: [], meta: fixtureMeta(T1) },
      { id: "ev01", type: "Event", module: "M03", label: "裏切り", story_order: 1, disclosure_phase: "ph2", based_on: [], meta: fixtureMeta(T1, { phase: "ph1" }) },
      { id: "ev02", type: "Event", module: "M03", label: "決裂", story_order: 2, disclosure_phase: null, based_on: [], meta: fixtureMeta(T1, { phase: "ph3" }) },
      {
        id: "th01",
        type: "Theme",
        module: "M10",
        label: "信頼の代償",
        question: "信頼は報われるか",
        values: ["信頼", "自己保存"],
        tension: "信じることと身を守ること",
        analysis: "人物甲の選択が主題を体現する。",
        based_on: ["ch01", "ev01"],
        meta: fixtureMeta(T1, { epistemic: "sfsh_analysis", authored: "haiku", support: "inferred" }),
      },
    ],
    edges: [
      { id: "rl01", type: "Relation", from: "ch01", to: "ch02", kind: "盟友", valence: "positive", phase_from: "ph1", phase_to: "ph2", changed_by: "ev01", meta: fixtureMeta(T1) },
      { id: "cs01", type: "Causes", from: "ev01", to: "ev02", kind: "causes", meta: fixtureMeta(T1) },
      { id: "em01", type: "Embodies", from: "ch01", to: "th01", meta: fixtureMeta(T1, { epistemic: "sfsh_analysis", authored: "haiku" }) },
    ],
    gaps: [{ module: "M05", what: "知識状態", reason: "insufficient_sources" }],
  };
}

// ---------------------------------------------------------------- fake ModelPort (tests only)
import type { ModelPort, ModelRequest, ModelResult, PortName } from "../model/types.ts";
import { strictSchemaViolations, validateAgainst } from "../model/validate.ts";

export interface FakeCall {
  port: PortName;
  req: ModelRequest;
}

/**
 * Fake port: `handler(req)` returns the canned output for a task. The output is validated against
 * req.schema (like LoggedModelPort); for luna the schema must be OpenAI-strict and tools must be "none".
 */
export function fakePort(port: PortName, handler: (req: ModelRequest) => unknown, calls: FakeCall[] = []): ModelPort {
  return {
    port,
    modelId: `fake-${port}`,
    async call(req: ModelRequest): Promise<ModelResult> {
      calls.push({ port, req });
      if (port === "luna") {
        const v = strictSchemaViolations(req.schema);
        if (v.length) throw new Error(`fake luna: non-strict schema for ${req.task}: ${v.slice(0, 3).join("; ")}`);
        if (req.tools !== "none") throw new Error(`fake luna: ${req.task} must use tools "none"`);
      } else if (req.tools && req.tools !== "none") throw new Error(`fake haiku: ${req.task} must not use tools`);
      const output = handler(req);
      if (output === undefined) throw new Error(`fake ${port}: no canned output for ${req.task}`);
      const ok = validateAgainst(req.schema, output);
      if (!ok.ok) throw new Error(`fake ${port}: canned output for ${req.task} violates schema: ${ok.summary}`);
      return { output, modelId: `fake-${port}`, reportedModelId: null, durationMs: 1, tokens: {} };
    },
  };
}

/** Fill every array key of an object schema with [] unless provided. */
export function fillGroup(schema: object, partial: Record<string, unknown[]>): Record<string, unknown[]> {
  const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const out: Record<string, unknown[]> = {};
  for (const k of Object.keys(props)) out[k] = partial[k] ?? [];
  return out;
}

const NODE_DEFAULTS = { summary: null, analysis: null, claim_refs: [], based_on: [], epistemic: "canon", phase_ref: null, spoiler: "none", coverage_ref: null };
const EDGE_DEFAULTS = { claim_refs: [], based_on: [], epistemic: "canon", phase_ref: null, spoiler: "none", coverage_ref: null };
export const mNode = (o: Record<string, unknown>) => ({ ...NODE_DEFAULTS, ...o });
export const mEdge = (o: Record<string, unknown>) => ({ ...EDGE_DEFAULTS, ...o });
