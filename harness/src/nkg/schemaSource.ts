import { BOOK_MENU } from "./bookMenu.ts";
/**
 * Source of truth for harness/schema/nkg.schema.json (REQUIREMENTS v1.3 §2.2–2.4).
 * The JSON file is generated from this module (`npx tsx harness/src/nkg/writeSchema.ts`) and a test keeps them in sync.
 *
 * C-2 / C-3: there is deliberately no type or field for scenes, dialogue, quotations, panels, cuts or
 * original text. Every object is closed (additionalProperties:false) so such fields are schema violations.
 */

export const MODULE_IDS = ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11", "M12", "B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B09", "B10", "B11"] as const;
export const NODE_TYPES = [
  "Thesis", "Argument", "Concept", "Evidence", "Outline", "AuthorContext", "Criticism", "Assumption", "Chronology", "OpenQuestion", "BookTopic",
  "Character",
  "Faction",
  "Event",
  "Outcome",
  "Why",
  "Secret",
  "Motive",
  "Arc",
  "WorldRule",
  "Setup",
  "Theme",
  "EmotionBeat",
  "Context",
  "IconicMoment",
  "Interpretation",
  "Quiz",
] as const;
export const EDGE_TYPES = [
  "ArgumentLink", "ConceptLink",
  "Relation",
  "Causes",
  "Knows",
  "Drives",
  "ConflictsWith",
  "TurnsAt",
  "Constrains",
  "PaysOff",
  "Embodies",
  "Evokes",
  "Explains",
  "About",
] as const;

type Json = Record<string, unknown>;

const str = (extra: Json = {}): Json => ({ type: "string", ...extra });
const nstr: Json = { type: ["string", "null"] };
const ref = (name: string): Json => ({ $ref: `#/definitions/${name}` });
const idList: Json = { type: "array", items: ref("id") };

const NODE_COMMON_PROPS: Json = {
  id: ref("id"),
  module: ref("node_module"),
  label: str({ minLength: 1 }),
  summary: str(),
  analysis: str(),
  based_on: idList,
  meta: ref("meta"),
};
const NODE_COMMON_REQUIRED = ["id", "type", "module", "label", "based_on", "meta"];

const EDGE_COMMON_PROPS: Json = {
  id: ref("id"),
  from: ref("id"),
  to: ref("id"),
  meta: ref("meta"),
};
const EDGE_COMMON_REQUIRED = ["id", "type", "from", "to", "meta"];

function nodeDef(type: string, props: Json): Json {
  const own = Object.keys(props);
  return {
    type: "object",
    additionalProperties: false,
    required: [...NODE_COMMON_REQUIRED, ...own],
    properties: { type: { const: type }, ...NODE_COMMON_PROPS, ...props },
  };
}

function edgeDef(type: string, props: Json, overrides: Json = {}): Json {
  const own = Object.keys(props);
  return {
    type: "object",
    additionalProperties: false,
    required: [...EDGE_COMMON_REQUIRED, ...own],
    properties: { type: { const: type }, ...EDGE_COMMON_PROPS, ...overrides, ...props },
  };
}

const NODE_FIELDS = {
  ...Object.fromEntries([...BOOK_MENU.map(m => m.type), "BookTopic"].map(t => [t, { stance: { enum: ["author_claim", "fact", "harness_interpretation"] }, section: nstr }])),
  Character: {},
  Faction: {},
  Event: {
    story_order: { type: ["integer", "null"], minimum: 1 },
    disclosure_phase: { anyOf: [ref("phase_id"), { type: "null" }] },
  },
  Outcome: {},
  Why: {
    level: { enum: ["direct", "factor", "root"] },
    factor_kind: { enum: ["political", "psychological", "social", "chance", "rule"] },
  },
  Secret: {},
  Motive: {
    owner: ref("id"),
    kind: { enum: ["goal", "fear", "belief", "conflict"] },
    phase_from: { anyOf: [ref("phase_id"), { type: "null" }] },
    phase_to: { anyOf: [ref("phase_id"), { type: "null" }] },
  },
  Arc: {
    character: ref("id"),
    initial_state: str({ minLength: 1 }),
    final_state: str({ minLength: 1 }),
    arc_type: str({ minLength: 1 }),
  },
  WorldRule: {
    kind: { enum: ["constraint", "ability", "institution"] },
    consequence: str({ minLength: 1 }),
  },
  Setup: { meaning: str({ minLength: 1 }) },
  Theme: {
    question: str({ minLength: 1 }),
    values: { type: "array", items: str({ minLength: 1 }) },
    tension: str({ minLength: 1 }),
  },
  EmotionBeat: {
    phase: ref("phase_id"),
    emotion: str({ minLength: 1 }),
    intensity: { type: "integer", minimum: 1, maximum: 5 },
    cause_refs: idList,
  },
  Context: { kind: { enum: ["reception", "award", "influence", "symbolism", "controversy"] } },
  IconicMoment: {
    event_ref: ref("id"),
    why_famous: str({ minLength: 1 }),
    context_refs: idList,
  },
  Interpretation: {
    topic: str({ minLength: 1 }),
    positions: { type: "array", minItems: 1, items: ref("position") },
  },
  Quiz: {
    question: str({ minLength: 1 }),
    answer: str({ minLength: 1 }),
    reasoning_refs: { type: "array", minItems: 1, items: ref("id") },
    quiz_type: { enum: ["causal", "motive", "counterfactual"] },
  },
};

const EDGE_FIELDS: Record<(typeof EDGE_TYPES)[number], { props: Json; overrides?: Json }> = {
  ArgumentLink: { props: { relation: str() } },
  ConceptLink: { props: { relation: str() } },
  Relation: {
    props: {
      kind: str({ minLength: 1 }),
      valence: { enum: ["positive", "negative", "ambivalent", "neutral"] },
      phase_from: { anyOf: [ref("phase_id"), { type: "null" }] },
      phase_to: { anyOf: [ref("phase_id"), { type: "null" }] },
      changed_by: { anyOf: [ref("id"), { type: "null" }] },
    },
  },
  Causes: { props: { kind: { enum: ["causes", "enables", "motivates", "prevents"] } } },
  Knows: {
    props: {
      holder: ref("holder"),
      phase: ref("phase_id"),
      state: { enum: ["unknown", "suspects", "misbelieves", "knows"] },
    },
    overrides: { from: ref("holder") },
  },
  Drives: { props: {} },
  ConflictsWith: { props: {} },
  TurnsAt: { props: {} },
  Constrains: { props: {} },
  PaysOff: { props: {} },
  Embodies: { props: {} },
  Evokes: { props: {} },
  Explains: { props: { refs: idList } },
  About: { props: {}, overrides: { to: { anyOf: [ref("id"), { const: "work" }] } } },
};

export function buildNkgSchema(): Json {
  const definitions: Json = {
    id: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" },
    phase_id: { type: "string", pattern: "^ph[0-9]{1,2}$" },
    holder: { anyOf: [ref("id"), { const: "audience" }] },
    module_id: { enum: [...MODULE_IDS] },
    node_module: { enum: [...MODULE_IDS, "extra"] },
    epistemic: { enum: ["canon", "consensus", "fan_theory", "sfsh_analysis"] },
    model_name: { enum: ["haiku", "luna"] },
    tier: { enum: ["T1", "T2", "T3", "T4", "T5"] },
    provenance_item: {
      type: "object",
      additionalProperties: false,
      required: ["source_id", "locator", "support"],
      properties: {
        source_id: str({ minLength: 1 }),
        locator: str({ minLength: 1 }),
        support: { enum: ["direct", "inferred"] },
      },
    },
    provenance: { type: "array", minItems: 1, items: ref("provenance_item") },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["score", "grade", "basis"],
      properties: {
        score: { type: "number", minimum: 0, maximum: 1 },
        grade: { enum: ["A", "B", "C", "D"] },
        basis: str(),
      },
    },
    meta: {
      type: "object",
      additionalProperties: false,
      required: [
        "provenance",
        "confidence",
        "epistemic",
        "coverage_ref",
        "phase_ref",
        "spoiler",
        "authored_by",
        "reviewed_by",
        "review",
      ],
      properties: {
        provenance: ref("provenance"),
        confidence: ref("confidence"),
        epistemic: ref("epistemic"),
        coverage_ref: nstr,
        phase_ref: { anyOf: [ref("phase_id"), { type: "null" }] },
        spoiler: { enum: ["none", "mid", "ending"] },
        authored_by: ref("model_name"),
        reviewed_by: ref("model_name"),
        review: { enum: ["agreed", "revised", "disputed"] },
      },
    },
    position: {
      type: "object",
      additionalProperties: false,
      required: ["claim", "epistemic", "provenance"],
      properties: {
        claim: str({ minLength: 1 }),
        epistemic: { enum: ["canon", "consensus", "fan_theory"] },
        provenance: ref("provenance"),
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["source_id", "url", "title", "publisher", "tier", "site_key", "license", "fetched_at"],
      properties: {
        source_id: str({ minLength: 1 }),
        url: str({ minLength: 1 }),
        title: str(),
        publisher: str(),
        tier: ref("tier"),
        site_key: str({ minLength: 1 }),
        license: nstr,
        fetched_at: str(),
      },
    },
    phase: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "order"],
      properties: { id: ref("phase_id"), label: str({ minLength: 1 }), order: { type: "integer", minimum: 1 } },
    },
    coverage_unit: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "from", "to", "label"],
      properties: {
        unit: { enum: ["volume", "episode", "arc", "season", "whole", "film", "installment", "part", "chapter", "section"] },
        from: { type: ["integer", "null"] },
        to: { type: ["integer", "null"] },
        label: str(),
      },
    },
    module_choice: {
      type: "object",
      additionalProperties: false,
      required: ["module", "weight", "enabled", "reason"],
      properties: {
        module: ref("module_id"),
        weight: { type: "number", minimum: 0 },
        enabled: { type: "boolean" },
        reason: str(),
      },
    },
    creator: {
      type: "object",
      additionalProperties: false,
      required: ["name", "role"],
      properties: { name: str({ minLength: 1 }), role: nstr },
    },
    work: {
      type: "object",
      additionalProperties: false,
      required: [
        "work_id",
        "title",
        "title_alt",
        "creators",
        "medium",
        "bibliographic",
        "genres",
        "coverage",
        "publish_mode",
        "rights",
        "module_selection",
        "phases",
      ],
      properties: {
        work_id: str({ minLength: 1 }),
        title: str({ minLength: 1 }),
        title_alt: { type: "array", items: str() },
        creators: { type: "array", items: ref("creator") },
        kind: { enum: ["fiction", "nonfiction", "mixed"] },
        medium: { enum: ["book", "novel", "manga", "anime", "film", "drama", "game", "other"] },
        bibliographic: {
          type: "object",
          additionalProperties: false,
          required: ["publisher", "first_release", "status", "source_ids"],
          properties: {
            publisher: nstr,
            first_release: nstr,
            status: { enum: ["completed", "ongoing", "unknown"] },
            source_ids: { type: "array", items: str() },
          },
        },
        genres: { type: "array", items: str() },
        coverage: { type: "array", items: ref("coverage_unit") },
        publish_mode: { enum: ["Public", "Restricted"] },
        rights: {
          type: "object",
          additionalProperties: false,
          required: ["state", "copyright_status", "holder_policy_note", "source_ids"],
          properties: {
            state: str(),
            copyright_status: { enum: ["in_copyright", "public_domain", "unknown"] },
            holder_policy_note: str(),
            source_ids: { type: "array", items: str() },
          },
        },
        module_selection: { type: "array", items: ref("module_choice") },
        phases: { type: "array", minItems: 3, maxItems: 7, items: ref("phase") },
      },
    },
    gap: {
      type: "object",
      additionalProperties: false,
      required: ["module", "what", "reason"],
      properties: {
        module: ref("node_module"),
        what: str(),
        reason: { enum: ["insufficient_sources", "conflicting_sources", "out_of_coverage"] },
      },
    },
  };

  for (const t of NODE_TYPES) definitions[`node_${t}`] = nodeDef(t, (NODE_FIELDS as Record<string, Json>)[t]);
  for (const t of EDGE_TYPES) definitions[`edge_${t}`] = edgeDef(t, EDGE_FIELDS[t].props, EDGE_FIELDS[t].overrides);

  definitions.node = {
    type: "object",
    required: ["type"],
    properties: { type: { enum: [...NODE_TYPES] } },
    discriminator: { propertyName: "type" },
    oneOf: NODE_TYPES.map((t) => ref(`node_${t}`)),
  };
  definitions.edge = {
    type: "object",
    required: ["type"],
    properties: { type: { enum: [...EDGE_TYPES] } },
    discriminator: { propertyName: "type" },
    oneOf: EDGE_TYPES.map((t) => ref(`edge_${t}`)),
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://sfsh.local/schema/nkg.schema.json",
    title: "SFSH Narrative Knowledge Graph",
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "work", "sources", "nodes", "edges", "gaps"],
    properties: {
      schema_version: { const: "1.0" },
      work: ref("work"),
      sources: { type: "array", items: ref("source") },
      nodes: { type: "array", items: ref("node") },
      edges: { type: "array", items: ref("edge") },
      gaps: { type: "array", items: ref("gap") },
    },
    definitions,
  };
}
