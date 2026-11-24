/** TypeScript mirror of harness/schema/nkg.schema.json (REQUIREMENTS v1.3 §2.2–2.4). */
import type { MODULE_IDS, NODE_TYPES, EDGE_TYPES } from "./schemaSource.ts";

export type ModuleId = (typeof MODULE_IDS)[number];
export type NodeModule = ModuleId | "extra";
export type NodeType = (typeof NODE_TYPES)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];
export type Tier = "T1" | "T2" | "T3" | "T4" | "T5";
export type Grade = "A" | "B" | "C" | "D";
export type Epistemic = "canon" | "consensus" | "fan_theory" | "sfsh_analysis";
export type ModelName = "haiku" | "luna";
export type ReviewState = "agreed" | "revised" | "disputed";
export type Spoiler = "none" | "mid" | "ending";

export interface ProvenanceItem {
  source_id: string;
  locator: string;
  support: "direct" | "inferred";
}

export interface Confidence {
  score: number;
  grade: Grade;
  basis: string;
}

export interface Meta {
  provenance: ProvenanceItem[];
  confidence: Confidence;
  epistemic: Epistemic;
  coverage_ref: string | null;
  phase_ref: string | null;
  spoiler: Spoiler;
  authored_by: ModelName;
  reviewed_by: ModelName;
  review: ReviewState;
}

export interface NodeBase {
  id: string;
  module: NodeModule;
  label: string;
  summary?: string;
  analysis?: string;
  /** Node ids this element rests on (sfsh_analysis). */
  based_on: string[];
  meta: Meta;
}

export interface CharacterNode extends NodeBase { type: "Character" }
export interface FactionNode extends NodeBase { type: "Faction" }
export interface EventNode extends NodeBase {
  type: "Event";
  story_order: number | null;
  disclosure_phase: string | null;
}
export interface OutcomeNode extends NodeBase { type: "Outcome" }
export interface WhyNode extends NodeBase {
  type: "Why";
  level: "direct" | "factor" | "root";
  factor_kind: "political" | "psychological" | "social" | "chance" | "rule";
}
export interface SecretNode extends NodeBase { type: "Secret" }
export interface MotiveNode extends NodeBase {
  type: "Motive";
  owner: string;
  kind: "goal" | "fear" | "belief" | "conflict";
  phase_from: string | null;
  phase_to: string | null;
}
export interface ArcNode extends NodeBase {
  type: "Arc";
  character: string;
  initial_state: string;
  final_state: string;
  arc_type: string;
}
export interface WorldRuleNode extends NodeBase {
  type: "WorldRule";
  kind: "constraint" | "ability" | "institution";
  consequence: string;
}
export interface SetupNode extends NodeBase { type: "Setup"; meaning: string }
export interface ThemeNode extends NodeBase {
  type: "Theme";
  question: string;
  values: string[];
  tension: string;
}
export interface EmotionBeatNode extends NodeBase {
  type: "EmotionBeat";
  phase: string;
  emotion: string;
  intensity: number;
  cause_refs: string[];
}
export interface ContextNode extends NodeBase {
  type: "Context";
  kind: "reception" | "award" | "influence" | "symbolism" | "controversy";
}
export interface IconicMomentNode extends NodeBase {
  type: "IconicMoment";
  event_ref: string;
  why_famous: string;
  context_refs: string[];
}
export interface InterpretationPosition {
  claim: string;
  epistemic: "canon" | "consensus" | "fan_theory";
  provenance: ProvenanceItem[];
}
export interface InterpretationNode extends NodeBase {
  type: "Interpretation";
  topic: string;
  positions: InterpretationPosition[];
}
export interface QuizNode extends NodeBase {
  type: "Quiz";
  question: string;
  answer: string;
  reasoning_refs: string[];
  /** Named quiz_type because `type` is the node discriminator. */
  quiz_type: "causal" | "motive" | "counterfactual";
}

export type NkgNode =
  | CharacterNode
  | FactionNode
  | EventNode
  | OutcomeNode
  | WhyNode
  | SecretNode
  | MotiveNode
  | ArcNode
  | WorldRuleNode
  | SetupNode
  | ThemeNode
  | EmotionBeatNode
  | ContextNode
  | IconicMomentNode
  | InterpretationNode
  | QuizNode;

export interface EdgeBase {
  id: string;
  from: string;
  to: string;
  meta: Meta;
}
export interface RelationEdge extends EdgeBase {
  type: "Relation";
  kind: string;
  valence: "positive" | "negative" | "ambivalent" | "neutral";
  phase_from: string | null;
  phase_to: string | null;
  /** Event id that changed the relation. */
  changed_by: string | null;
}
export interface CausesEdge extends EdgeBase { type: "Causes"; kind: "causes" | "enables" | "motivates" | "prevents" }
/** from = holder (Character id or "audience"), to = Secret id. */
export interface KnowsEdge extends EdgeBase {
  type: "Knows";
  holder: string;
  phase: string;
  state: "unknown" | "suspects" | "misbelieves" | "knows";
}
export interface DrivesEdge extends EdgeBase { type: "Drives" }
export interface ConflictsWithEdge extends EdgeBase { type: "ConflictsWith" }
export interface TurnsAtEdge extends EdgeBase { type: "TurnsAt" }
export interface ConstrainsEdge extends EdgeBase { type: "Constrains" }
export interface PaysOffEdge extends EdgeBase { type: "PaysOff" }
export interface EmbodiesEdge extends EdgeBase { type: "Embodies" }
export interface EvokesEdge extends EdgeBase { type: "Evokes" }
export interface ExplainsEdge extends EdgeBase { type: "Explains"; refs: string[] }
/** to may be "work" (the work as a whole). */
export interface AboutEdge extends EdgeBase { type: "About" }

export type NkgEdge =
  | RelationEdge
  | CausesEdge
  | KnowsEdge
  | DrivesEdge
  | ConflictsWithEdge
  | TurnsAtEdge
  | ConstrainsEdge
  | PaysOffEdge
  | EmbodiesEdge
  | EvokesEdge
  | ExplainsEdge
  | AboutEdge;

export interface NkgSource {
  source_id: string;
  url: string;
  title: string;
  publisher: string;
  tier: Tier;
  site_key: string;
  license: string | null;
  fetched_at: string;
}

export interface Phase {
  id: string;
  label: string;
  order: number;
}

export interface CoverageUnit {
  unit: "volume" | "episode" | "arc" | "season" | "whole" | "film" | "installment";
  from: number | null;
  to: number | null;
  label: string;
}

export interface ModuleChoice {
  module: ModuleId;
  weight: number;
  enabled: boolean;
  reason: string;
}

export type GapReason = "insufficient_sources" | "conflicting_sources" | "out_of_coverage";
export interface Gap {
  module: NodeModule;
  what: string;
  reason: GapReason;
}

export interface NkgWork {
  work_id: string;
  title: string;
  title_alt: string[];
  creators: { name: string; role: string | null }[];
  medium: "novel" | "manga" | "anime" | "film" | "drama" | "game" | "other";
  bibliographic: {
    publisher: string | null;
    first_release: string | null;
    status: "completed" | "ongoing" | "unknown";
    source_ids: string[];
  };
  genres: string[];
  coverage: CoverageUnit[];
  publish_mode: "Public" | "Restricted";
  rights: {
    state: string;
    copyright_status: "in_copyright" | "public_domain" | "unknown";
    holder_policy_note: string;
    source_ids: string[];
  };
  module_selection: ModuleChoice[];
  phases: Phase[];
}

export interface Nkg {
  schema_version: "1.0";
  work: NkgWork;
  sources: NkgSource[];
  nodes: NkgNode[];
  edges: NkgEdge[];
  gaps: Gap[];
}

/** Element = node or edge. */
export type NkgElement = NkgNode | NkgEdge;
