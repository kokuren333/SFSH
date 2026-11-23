/**
 * Model-facing element shapes for S2 authoring (WP-1.5).
 *
 * The model never writes provenance, confidence, authored_by/reviewed_by or review: it returns per element
 * `claim_refs` (claim ids) and `based_on` (node ids), plus epistemic / phase_ref / spoiler / coverage_ref.
 * Code maps those to meta (finalize.ts). All schemas here are OpenAI-strict (optional = nullable).
 */
import type { EdgeType, ModuleId, NodeModule, NodeType } from "./types.ts";

type Json = Record<string, unknown>;

export interface ElementSpec {
  kind: NodeType | EdgeType;
  edge: boolean;
  /** Key of the array in model output, e.g. "events". */
  key: string;
  module: NodeModule;
  idPrefix: string;
  /** Type-specific fields (model shape). */
  fields: Json;
  /** Short Japanese guidance for the prompt. */
  guide: string;
}

const s = { type: "string" };
const ns = { type: ["string", "null"] };
const sArr = { type: "array", items: { type: "string" } };
const en = (...v: string[]) => ({ type: "string", enum: v });

export const SPECS: Record<NodeType | EdgeType, ElementSpec> = {
  // ---- fact layer ----
  Event: { kind: "Event", edge: false, key: "events", module: "M03", idPrefix: "ev", fields: { story_order: { type: ["integer", "null"] }, disclosure_phase: ns }, guide: "物語の因果に効く転換点だけ（範囲1単位あたり8件程度）。場面の連続にしない。story_order=作中の実際の時系列順（1始まり）、disclosure_phase=読者に明かされるフェーズID（時系列の二重化を扱わないときは null）" },
  Causes: { kind: "Causes", edge: true, key: "causes", module: "M03", idPrefix: "cs", fields: { kind: en("causes", "enables", "motivates", "prevents") }, guide: "Event→Event の因果。from=原因、to=結果。主要な Event がばらばらに孤立しないよう、つながる因果をすべて作る（直接言えなければ sfsh_analysis）" },
  Character: { kind: "Character", edge: false, key: "characters", module: "M01", idPrefix: "ch", fields: {}, guide: "人物（30人程度まで）。label は人物の名前だけ（作中の呼び名。説明句にしない。例: ×「願いを保留する主人公」→ ○ 名前）。役割・説明は summary に書く" },
  Faction: { kind: "Faction", edge: false, key: "factions", module: "M01", idPrefix: "fa", fields: {}, guide: "組織・勢力・集団" },
  Relation: { kind: "Relation", edge: true, key: "relations", module: "M01", idPrefix: "rl", fields: { kind: s, valence: en("positive", "negative", "ambivalent", "neutral"), phase_from: ns, phase_to: ns, changed_by: ns }, guide: "人物・勢力間の関係。フェーズ区間つき（phase_from/phase_to はフェーズID、null=開始時/終了時まで）。関係が変わった原因は changed_by に Event ID。変化の前後は別の Relation にする。主要人物が2人以上いれば、claim から言える関係（直接言えなければ sfsh_analysis）を少なくとも人物数−1 件作る" },
  Secret: { kind: "Secret", edge: false, key: "secrets", module: "M05", idPrefix: "se", fields: {}, guide: "隠された事実（12件程度まで）。中身は抽象的に" },
  Knows: { kind: "Knows", edge: true, key: "knows", module: "M05", idPrefix: "kn", fields: { holder: s, phase: s, state: en("unknown", "suspects", "misbelieves", "knows") }, guide: "誰がどのフェーズで秘密をどう知っているか。holder=Character ID または \"audience\"（読者）、from=holder と同じ、to=Secret ID" },
  WorldRule: { kind: "WorldRule", edge: false, key: "world_rules", module: "M08", idPrefix: "wr", fields: { kind: en("constraint", "ability", "institution"), consequence: s }, guide: "世界の制約・能力・制度と、それが物語に及ぼす帰結" },
  Constrains: { kind: "Constrains", edge: true, key: "constrains", module: "M08", idPrefix: "cn", fields: {}, guide: "WorldRule→Event/Character" },
  Setup: { kind: "Setup", edge: false, key: "setups", module: "M09", idPrefix: "su", fields: { meaning: s }, guide: "伏線。手掛かりの物語上の機能（meaning）を書き、場面描写は書かない（8件程度まで）" },
  PaysOff: { kind: "PaysOff", edge: true, key: "pays_off", module: "M09", idPrefix: "po", fields: {}, guide: "Setup→Event（回収先）" },
  Context: { kind: "Context", edge: false, key: "contexts", module: "M12", idPrefix: "cx", fields: { kind: en("reception", "award", "influence", "symbolism", "controversy") }, guide: "受容・受賞・影響・象徴・論争（12件程度まで）。T1/T2 出典の claim を優先" },
  About: { kind: "About", edge: true, key: "about", module: "M12", idPrefix: "ab", fields: {}, guide: "Context→Theme/Event、作品全体なら to=\"work\"" },
  // ---- interpretive layer ----
  Outcome: { kind: "Outcome", edge: false, key: "outcomes", module: "M02", idPrefix: "oc", fields: {}, guide: "結末（木の根）。通常1〜2件" },
  Why: { kind: "Why", edge: false, key: "whys", module: "M02", idPrefix: "wy", fields: { level: en("direct", "factor", "root"), factor_kind: en("political", "psychological", "social", "chance", "rule") }, guide: "結末に至った理由（20件程度まで、深さ4まで）。level: direct=直接の理由/factor=要因/root=根本原因" },
  Explains: { kind: "Explains", edge: true, key: "explains", module: "M02", idPrefix: "xp", fields: { refs: sArr }, guide: "Why→Outcome/Why（結末を根とする木）。refs に裏づけの Event/Motive/WorldRule ID" },
  Motive: { kind: "Motive", edge: false, key: "motives", module: "M06", idPrefix: "mo", fields: { owner: s, kind: en("goal", "fear", "belief", "conflict"), phase_from: ns, phase_to: ns }, guide: "人物の目標・恐れ・信念・葛藤（人物あたり4件程度まで）。owner=Character ID" },
  Drives: { kind: "Drives", edge: true, key: "drives", module: "M06", idPrefix: "dr", fields: {}, guide: "Motive→Event" },
  ConflictsWith: { kind: "ConflictsWith", edge: true, key: "conflicts", module: "M06", idPrefix: "cw", fields: {}, guide: "Motive↔Motive の対立" },
  Arc: { kind: "Arc", edge: false, key: "arcs", module: "M07", idPrefix: "ar", fields: { character: s, initial_state: s, final_state: s, arc_type: s }, guide: "主要人物の変容（8件程度まで）。character=Character ID、arc_type 例: 成長/堕落/喪失/回復/不変" },
  TurnsAt: { kind: "TurnsAt", edge: true, key: "turns_at", module: "M07", idPrefix: "ta", fields: {}, guide: "Arc→Event（変容の転機）" },
  Theme: { kind: "Theme", edge: false, key: "themes", module: "M10", idPrefix: "th", fields: { question: s, values: sArr, tension: s }, guide: "作品が問う問い（6件程度まで）。values=対立する価値、tension=緊張の中身" },
  Embodies: { kind: "Embodies", edge: true, key: "embodies", module: "M10", idPrefix: "em", fields: {}, guide: "Character/Event/WorldRule→Theme" },
  EmotionBeat: { kind: "EmotionBeat", edge: false, key: "emotion_beats", module: "M11", idPrefix: "eb", fields: { phase: s, emotion: s, intensity: { type: "integer" }, cause_refs: sArr }, guide: "フェーズ単位の感情の山（フェーズあたり3件程度まで）。intensity は1〜5、cause_refs に原因ノード ID" },
  Evokes: { kind: "Evokes", edge: true, key: "evokes", module: "M11", idPrefix: "vk", fields: {}, guide: "Event→EmotionBeat" },
  IconicMoment: { kind: "IconicMoment", edge: false, key: "iconic_moments", module: "extra", idPrefix: "im", fields: { event_ref: s, why_famous: s, context_refs: sArr }, guide: "象徴的な瞬間（最大5件）。event_ref=Event ID、なぜ有名かを Context（context_refs）で裏づける。台詞・構図の再現は禁止" },
  Interpretation: {
    kind: "Interpretation",
    edge: false,
    key: "interpretations",
    module: "extra",
    idPrefix: "ip",
    fields: {
      topic: s,
      positions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "epistemic", "claim_refs"],
          properties: { claim: s, epistemic: en("canon", "consensus", "fan_theory"), claim_refs: sArr },
        },
      },
    },
    guide: "解釈の分岐。topic ごとに立場（positions）を並べ、canon/consensus/fan_theory を必ず分ける。各立場に claim_refs",
  },
  Quiz: { kind: "Quiz", edge: false, key: "quizzes", module: "extra", idPrefix: "qz", fields: { question: s, answer: s, reasoning_refs: sArr, quiz_type: en("causal", "motive", "counterfactual") }, guide: "理解度テスト（最大10問）。因果・動機・反実仮想だけ。固有名や数値を当てる暗記問題は禁止。reasoning_refs に推論の根拠ノード ID（既存ノードの ID。claim ID ではない）" },
};

const COMMON_NODE: Json = {
  id: s,
  label: s,
  summary: ns,
  analysis: ns,
  claim_refs: sArr,
  based_on: sArr,
  epistemic: en("canon", "consensus", "fan_theory", "sfsh_analysis"),
  phase_ref: ns,
  spoiler: en("none", "mid", "ending"),
  coverage_ref: ns,
};
const COMMON_EDGE: Json = {
  id: s,
  from: s,
  to: s,
  claim_refs: sArr,
  based_on: sArr,
  epistemic: en("canon", "consensus", "fan_theory", "sfsh_analysis"),
  phase_ref: ns,
  spoiler: en("none", "mid", "ending"),
  coverage_ref: ns,
};

export function elementSchema(spec: ElementSpec): Json {
  const properties = { ...(spec.edge ? COMMON_EDGE : COMMON_NODE), ...spec.fields };
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

/** Strict output schema with one array per spec. */
export function groupSchema(specs: ElementSpec[]): Json {
  const properties: Json = {};
  for (const sp of specs) properties[sp.key] = { type: "array", items: elementSchema(sp) };
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

export interface CallGroup {
  name: string;
  kinds: (NodeType | EdgeType)[];
}

/** Fact layer (Luna): events first so later groups can reference event ids. */
export const FACT_GROUPS: CallGroup[] = [
  { name: "events", kinds: ["Event", "Causes"] },
  { name: "people", kinds: ["Character", "Faction", "Relation", "Secret", "Knows"] },
  { name: "world", kinds: ["WorldRule", "Constrains", "Setup", "PaysOff", "Context", "About"] },
];

/** Interpretive layer (Haiku). */
export const INTERP_GROUPS: CallGroup[] = [
  { name: "reverse_plot", kinds: ["Outcome", "Why", "Explains"] },
  { name: "motives_arcs", kinds: ["Motive", "Drives", "ConflictsWith", "Arc", "TurnsAt"] },
  { name: "themes_emotion", kinds: ["Theme", "Embodies", "EmotionBeat", "Evokes"] },
  { name: "extras", kinds: ["IconicMoment", "Interpretation", "Quiz"] },
];

export const FACT_MODULES: ModuleId[] = ["M01", "M03", "M04", "M05", "M08", "M09", "M12"];
export const INTERP_MODULES: ModuleId[] = ["M02", "M06", "M07", "M10", "M11"];

/** Specs of a group whose module is enabled ("extra" is always on). */
export function enabledSpecs(group: CallGroup, enabled: Set<string>): ElementSpec[] {
  return group.kinds.map((k) => SPECS[k]).filter((sp) => sp.module === "extra" || enabled.has(sp.module));
}

/** A draft element: model-shape fields + `_type` (element type; `kind` stays the type-specific field). Kept in nkg/layers/<layer>.json (internal). */
export type Draft = Record<string, unknown> & { _type: NodeType | EdgeType; id: string };

export function specFor(d: Draft): ElementSpec {
  return SPECS[d._type];
}

/** Turn a group output object into drafts. */
export function draftsFromOutput(output: unknown, specs: ElementSpec[]): Draft[] {
  const out: Draft[] = [];
  const o = (output ?? {}) as Record<string, unknown>;
  for (const sp of specs) {
    const arr = o[sp.key];
    if (!Array.isArray(arr)) continue;
    for (const el of arr) if (el && typeof el === "object") out.push({ ...(el as Record<string, unknown>), _type: sp.kind, id: String((el as { id?: unknown }).id ?? "") });
  }
  return out;
}

/** Back to model shape (for review / revision prompts). */
export function draftsToOutput(drafts: Draft[], specs: ElementSpec[]): Record<string, unknown[]> {
  const o: Record<string, unknown[]> = {};
  for (const sp of specs) o[sp.key] = [];
  for (const d of drafts) {
    const sp = SPECS[d._type];
    if (!o[sp.key]) continue;
    const { _type: _t, ...rest } = d;
    o[sp.key].push(rest);
  }
  return o;
}

const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const RESERVED = new Set(["audience", "work", "layer"]);

/**
 * Normalize ids: lowercase, valid pattern, unique across `taken` (shared node/edge namespace).
 * Invalid or duplicate ids get `<prefix><n>`. Returns renames for the report.
 */
export function normalizeIds(drafts: Draft[], taken: Set<string>): { id: string; from: string }[] {
  const renames: { id: string; from: string }[] = [];
  const counters = new Map<string, number>();
  const next = (prefix: string) => {
    let n = counters.get(prefix) ?? 1;
    let id: string;
    do id = `${prefix}${String(n++).padStart(2, "0")}`;
    while (taken.has(id));
    counters.set(prefix, n);
    return id;
  };
  for (const d of drafts) {
    const raw = String(d.id ?? "").trim().toLowerCase();
    if (ID_RE.test(raw) && !RESERVED.has(raw) && !taken.has(raw)) {
      d.id = raw;
    } else {
      const id = next(SPECS[d._type].idPrefix);
      renames.push({ id, from: String(d.id ?? "") });
      d.id = id;
    }
    taken.add(d.id);
  }
  return renames;
}
