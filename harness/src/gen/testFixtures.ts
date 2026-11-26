/** S3 test fixtures (tests only; no network, no real work data). */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StageContext } from "../job/context.ts";
import type { ModelPort } from "../model/types.ts";
import { computeConfidence } from "../nkg/confidence.ts";
import type { Epistemic, Meta, ModelName, Nkg, NkgSource, Spoiler } from "../nkg/types.ts";
import type { Claim } from "../research/claimTypes.ts";
import type { SourceCard } from "../research/types.ts";
import type { Work } from "../works/types.ts";

export const GEN_WORK_ID = "novel-gen-fixture-2001";

const SRC: [string, NkgSource["tier"], string, string | null][] = [
  ["s000000001", "T1", "pub.example", null],
  ["s000000002", "T3", "wiki.example", "CC BY-SA 4.0"],
  ["s000000003", "T4", "fan.example", null],
  ["s000000004", "T1", "unused.example", null], // never referenced
  ["s000000005", "T2", "hidden.example", null], // referenced only by a non-public element
];
export const GEN_SOURCES: NkgSource[] = SRC.map(([source_id, tier, site, license]) => ({
  source_id,
  url: `https://${site}/page`,
  title: `${site} の頁`,
  publisher: site,
  tier,
  site_key: site,
  license,
  fetched_at: "2026-11-20T10:00:00+09:00",
}));

/** A sentence present verbatim in a saved source raw text (≥ 30 chars) — used for the guard tests. */
export const COPIED_SENTENCE = "これは出典の本文に含まれている三十文字を超える長い一文であり検査で必ず一致するはずの文章です。";
export const HIDDEN_LABEL = "非公開の人物丁";
export const INTERNAL_ANALYSIS = "内部分析テキスト（公開しない）";
export const EXCERPT_TEXT = "検証用抜粋（非公開）";
/** S2 analysis of public element types (CP-026: published). */
export const PUBLIC_ANALYSIS = "テーマについての分析（公開してよい）";

function meta(sources: string[], o: { epi?: Epistemic; spoiler?: Spoiler; by?: ModelName; claim?: string } = {}): Meta {
  const provenance = sources.map((s) => ({ source_id: s, locator: `claim:${o.claim ?? "c0001"}`, support: "direct" as const }));
  const by = o.by ?? "luna";
  return {
    provenance,
    confidence: computeConfidence(provenance, new Map(GEN_SOURCES.map((s) => [s.source_id, s] as const)), "agreed"),
    epistemic: o.epi ?? "canon",
    coverage_ref: "全体",
    phase_ref: null,
    spoiler: o.spoiler ?? "none",
    authored_by: by,
    reviewed_by: by === "luna" ? "haiku" : "luna",
    review: "agreed",
  };
}

const T1 = ["s000000001"];

export function genNkg(): Nkg {
  const H = { by: "haiku" as const, epi: "sfsh_analysis" as const };
  return {
    schema_version: "1.0",
    work: {
      work_id: GEN_WORK_ID,
      title: "生成試験作品",
      title_alt: [],
      creators: [{ name: "作者甲", role: "著者" }],
      medium: "novel",
      bibliographic: { publisher: "版元", first_release: "2001-04", status: "completed", source_ids: T1 },
      genres: ["mystery", "not_a_genre"],
      coverage: [{ unit: "whole", from: null, to: null, label: "全体" }],
      publish_mode: "Public",
      rights: { state: "unchecked", copyright_status: "in_copyright", holder_policy_note: "", source_ids: [] },
      module_selection: [
        { module: "M10", weight: 1, enabled: true, reason: "theme fixture is selected" },
        { module: "M01", weight: 1, enabled: true, reason: "always_on" },
        { module: "M02", weight: 1, enabled: true, reason: "always_on" },
        { module: "M04", weight: 1, enabled: true, reason: "genre:mystery" },
        { module: "M05", weight: 1, enabled: true, reason: "genre:mystery" },
      ],
      phases: [
        { id: "ph1", label: "序盤", order: 1 },
        { id: "ph2", label: "中盤", order: 2 },
        { id: "ph3", label: "結末", order: 3 },
      ],
    },
    sources: GEN_SOURCES,
    nodes: [
      { id: "ch01", type: "Character", module: "M01", label: "人物甲", summary: "物語の中心にいる人物。", analysis: INTERNAL_ANALYSIS, based_on: [], meta: meta(T1) },
      { id: "ch02", type: "Character", module: "M01", label: "人物乙", summary: "甲の相棒。", based_on: [], meta: meta(T1) },
      { id: "ch03", type: "Character", module: "M01", label: "人物丙", based_on: [], meta: meta(T1, { spoiler: "mid" }) },
      { id: "ch04", type: "Character", module: "M01", label: HIDDEN_LABEL, based_on: [], meta: meta(["s000000005"]) },
      { id: "fa01", type: "Faction", module: "M01", label: "組織", based_on: [], meta: meta(T1) },
      { id: "ev01", type: "Event", module: "M03", label: "裏切りの発覚", story_order: 1, disclosure_phase: "ph2", based_on: [], meta: meta(T1, { spoiler: "mid" }) },
      { id: "ev02", type: "Event", module: "M03", label: "対立の激化", story_order: 2, disclosure_phase: null, based_on: [], meta: meta(T1) },
      { id: "ev03", type: "Event", module: "M03", label: "和解", story_order: 3, disclosure_phase: null, based_on: [], meta: meta(T1, { spoiler: "ending" }) },
      { id: "ev04", type: "Event", module: "M03", label: "未確認の出来事", story_order: 4, disclosure_phase: null, based_on: [], meta: meta(["s000000005"]) },
      { id: "oc01", type: "Outcome", module: "M02", label: "甲が組織を離れる", summary: "結末。", based_on: ["ev03"], meta: meta(T1, { ...H, spoiler: "ending" }) },
      { id: "oc02", type: "Outcome", module: "M02", label: "乙が残る", based_on: ["ev02"], meta: meta(T1, { ...H, spoiler: "mid" }) },
      { id: "wy01", type: "Why", module: "M02", label: "信頼の崩壊", analysis: "崩壊の読み解き。", level: "direct", factor_kind: "psychological", based_on: ["ev01"], meta: meta(T1, { ...H, spoiler: "mid" }) },
      { id: "wy02", type: "Why", module: "M02", label: "組織の圧力", level: "factor", factor_kind: "political", based_on: ["ev02"], meta: meta(T1, H) },
      { id: "wy03", type: "Why", module: "M02", label: "過去の約束", level: "root", factor_kind: "social", based_on: ["ev01"], meta: meta(T1, H) },
      { id: "wy04", type: "Why", module: "M02", label: "根拠不足の要因", level: "factor", factor_kind: "chance", based_on: ["ev04"], meta: meta(["s000000005"], H) },
      { id: "wy05", type: "Why", module: "M02", label: "乙の忠誠", level: "direct", factor_kind: "psychological", based_on: ["ch02"], meta: meta(T1, H) },
      { id: "se01", type: "Secret", module: "M05", label: "甲の過去", based_on: [], meta: meta(T1, { spoiler: "mid" }) },
      { id: "se02", type: "Secret", module: "M05", label: "非公開の秘密", based_on: [], meta: meta(["s000000005"]) },
      {
        id: "th01",
        type: "Theme",
        module: "M10",
        label: "信頼の代償",
        question: "信頼は報われるか",
        values: ["信頼", "自己保存"],
        tension: "信じることと身を守ること",
        summary: "信頼と自己保存の綱引き。",
        analysis: PUBLIC_ANALYSIS,
        based_on: ["ch01"],
        meta: meta(["s000000002"], H),
      },
      { id: "cx01", type: "Context", module: "M12", kind: "award", label: "架空の賞を受賞", based_on: [], meta: meta(T1) },
      { id: "im01", type: "IconicMoment", module: "extra", label: "決別の場面", event_ref: "ev03", why_famous: "多くの評で取り上げられたため。", context_refs: ["cx01"], based_on: ["ev03", "cx01"], meta: meta(T1, { ...H, spoiler: "ending" }) },
      {
        id: "ip01",
        type: "Interpretation",
        module: "extra",
        label: "離脱の意味",
        topic: "甲の離脱は敗北か",
        positions: [
          { claim: "解放と読む見方がある。", epistemic: "consensus", provenance: [{ source_id: "s000000003", locator: "claim:c0003", support: "direct" }] },
          { claim: "敗北と読む見方もある。", epistemic: "fan_theory", provenance: [{ source_id: "s000000003", locator: "claim:c0004", support: "direct" }] },
        ],
        based_on: ["oc01"],
        meta: meta(["s000000003"], { ...H, spoiler: "ending" }),
      },
      { id: "mo01", type: "Motive", module: "M06", label: "居場所を守りたい", owner: "ch01", kind: "goal", phase_from: "ph1", phase_to: "ph2", analysis: "動機の分析。", based_on: ["ch01"], meta: meta(T1, H) },
      { id: "mo02", type: "Motive", module: "M06", label: "見捨てられる恐れ", owner: "ch02", kind: "fear", phase_from: null, phase_to: null, based_on: ["ch02"], meta: meta(T1, H) },
      { id: "mo03", type: "Motive", module: "M06", label: "非公開人物の動機", owner: "ch04", kind: "goal", phase_from: null, phase_to: null, based_on: [], meta: meta(T1) },
      { id: "ar01", type: "Arc", module: "M07", label: "乙の自立", character: "ch02", initial_state: "依存", final_state: "自立", arc_type: "成長", based_on: ["ch02"], meta: meta(T1, H) },
      { id: "wr01", type: "WorldRule", module: "M08", label: "掟", kind: "constraint", consequence: "離脱には代償が要る", based_on: [], meta: meta(T1) },
      { id: "su01", type: "Setup", module: "M09", label: "古い約束", meaning: "後の決別の意味を準備する", based_on: [], meta: meta(T1) },
      { id: "eb01", type: "EmotionBeat", module: "M11", label: "不安の高まり", phase: "ph2", emotion: "不安", intensity: 3, cause_refs: ["ev02", "ev04", "zz99"], based_on: [], meta: meta(T1) },
      { id: "qz01", type: "Quiz", module: "extra", label: "離脱の理由", question: "甲はなぜ組織を離れたのか", answer: "信頼が崩れたため", analysis: "崩壊が直接の原因。", reasoning_refs: ["wy01", "ev01", "ch04"], quiz_type: "causal", based_on: ["wy01"], meta: meta(T1, { ...H, spoiler: "mid" }) },
      { id: "qz02", type: "Quiz", module: "extra", label: "非公開", question: "非公開の問い", answer: "非公開", reasoning_refs: ["wy04"], quiz_type: "causal", based_on: ["wy04"], meta: meta(["s000000005"], H) },
    ],
    edges: [
      { id: "rl01", type: "Relation", from: "ch01", to: "ch02", kind: "相棒", valence: "positive", phase_from: "ph1", phase_to: "ph2", changed_by: "ev01", meta: meta(T1) },
      { id: "rl02", type: "Relation", from: "ch01", to: "ch03", kind: "旧友", valence: "neutral", phase_from: null, phase_to: null, changed_by: null, meta: meta(["s000000002"]) },
      { id: "rl03", type: "Relation", from: "ch02", to: "ch04", kind: "敵対", valence: "negative", phase_from: null, phase_to: null, changed_by: null, meta: meta(T1) },
      { id: "rl04", type: "Relation", from: "ch01", to: "fa01", kind: "所属", valence: "neutral", phase_from: null, phase_to: null, changed_by: null, meta: meta(T1, { spoiler: "mid" }) },
      { id: "rl05", type: "Relation", from: "ch03", to: "ch02", kind: "不明", valence: "neutral", phase_from: null, phase_to: null, changed_by: null, meta: meta(T1) },
      { id: "xp01", type: "Explains", from: "wy01", to: "oc01", refs: [], meta: meta(T1, { ...H, spoiler: "ending" }) },
      { id: "xp02", type: "Explains", from: "wy02", to: "wy01", refs: [], meta: meta(T1, H) },
      { id: "xp03", type: "Explains", from: "wy03", to: "wy02", refs: [], meta: meta(T1, H) },
      { id: "xp04", type: "Explains", from: "wy04", to: "wy01", refs: [], meta: meta(T1, H) },
      { id: "xp05", type: "Explains", from: "wy01", to: "wy03", refs: [], meta: meta(T1, H) }, // cycle
      { id: "xp06", type: "Explains", from: "wy05", to: "oc02", refs: [], meta: meta(T1, H) },
      { id: "cs01", type: "Causes", from: "ev01", to: "ev02", kind: "causes", meta: meta(T1) },
      { id: "cs02", type: "Causes", from: "ev02", to: "ev03", kind: "enables", meta: meta(T1, { spoiler: "ending" }) },
      { id: "cs03", type: "Causes", from: "ev02", to: "ev04", kind: "causes", meta: meta(T1) }, // non-public endpoint
      { id: "cs04", type: "Causes", from: "ev01", to: "ev03", kind: "causes", meta: meta(T1) }, // edge not eligible
      { id: "dr01", type: "Drives", from: "mo01", to: "ev01", meta: meta(T1, H) },
      { id: "dr02", type: "Drives", from: "mo01", to: "ev04", meta: meta(T1, H) },
      { id: "cw01", type: "ConflictsWith", from: "mo01", to: "mo02", meta: meta(T1, H) },
      { id: "cw02", type: "ConflictsWith", from: "mo01", to: "mo03", meta: meta(T1, H) }, // mo03 not shown (owner non-public)
      { id: "ta01", type: "TurnsAt", from: "ar01", to: "ev03", meta: meta(T1, { ...H, spoiler: "ending" }) },
      { id: "co01", type: "Constrains", from: "wr01", to: "ch01", meta: meta(T1) },
      { id: "co02", type: "Constrains", from: "wr01", to: "ev02", meta: meta(T1) },
      { id: "po01", type: "PaysOff", from: "su01", to: "ev03", meta: meta(T1, { spoiler: "ending" }) },
      { id: "evk01", type: "Evokes", from: "ev01", to: "eb01", meta: meta(T1) },
      { id: "kn01", type: "Knows", from: "audience", to: "se01", holder: "audience", phase: "ph2", state: "knows", meta: meta(T1, { spoiler: "ending" }) },
      { id: "kn02", type: "Knows", from: "ch01", to: "se01", holder: "ch01", phase: "ph1", state: "suspects", meta: meta(T1) },
      { id: "kn03", type: "Knows", from: "ch04", to: "se01", holder: "ch04", phase: "ph1", state: "knows", meta: meta(T1) },
      { id: "kn04", type: "Knows", from: "ch02", to: "se02", holder: "ch02", phase: "ph1", state: "knows", meta: meta(T1) },
    ],
    gaps: [
      { module: "M09", what: "伏線", reason: "insufficient_sources" },
      { module: "M09", what: "伏線（重複）", reason: "insufficient_sources" },
    ],
  };
}

/** Non-public ids (validation public_eligible=false). rl03 / kn03 / kn04 are eligible but have a non-public endpoint. */
export const NON_PUBLIC = ["ch04", "ev04", "wy04", "se02", "qz02", "rl05", "xp04", "cs04"];

export function genValidation(nkg: Nkg = genNkg()) {
  const elements: Record<string, { grade: string; public_eligible: boolean; reasons: string[] }> = {};
  for (const el of [...nkg.nodes, ...nkg.edges]) elements[el.id] = { grade: el.meta.confidence.grade, public_eligible: !NON_PUBLIC.includes(el.id), reasons: [] };
  return { validated_at: "2026-11-23T00:00:00Z", schema_version: "1.0", ok: true, errors: [], warnings: [], elements };
}

export function genCards(): SourceCard[] {
  return GEN_SOURCES.map((s) => ({
    source_id: s.source_id,
    url: s.url,
    final_url: s.url,
    title: s.title,
    publisher: s.publisher,
    domain: s.site_key,
    site_key: s.site_key,
    tier: s.tier,
    tier_basis: "table",
    license: s.license,
    fetched_at: s.fetched_at,
    content_hash: "sha256:00",
    raw_text_path: `research/raw/${s.source_id}.txt`,
    text_chars: 100,
    excerpts: [{ text: EXCERPT_TEXT, offset: 0, claim_ids: ["c0001"] }],
    origin: { kind: "instruction", note: "test" },
  }));
}

export function genClaims(): Claim[] {
  return ["c0001", "c0002", "c0003", "c0004"].map((claim_id) => ({
    claim_id,
    text: `主張 ${claim_id}（自分の言葉）`,
    source_ids: ["s000000001"],
    evidence: [{ source_id: "s000000001", offset: 0, length: 4 }],
    aspects: ["M01"],
    epistemic: "canon",
    phase_hint: "whole",
    spoiler: "none",
    entities: [],
    authored_by: "luna",
    reviewed_by: "haiku",
    review: "agreed",
    status: "active",
    drop_reason: null,
  }));
}

export function genWork(): Work {
  return {
    work_id: GEN_WORK_ID,
    title: "生成試験作品",
    title_original: "Gen Fixture",
    title_reading: "せいせい しけん さくひん",
    title_reading_basis: "source",
    title_status: "confirmed",
    title_source_ids: T1,
    aliases: [
      { text: "生成試験", kind: "common", attested: true, source_ids: ["s000000002"], origin_job_id: "j", first_seen: "2026-11-20T00:00:00Z" },
      { text: "せいせいしけん", kind: "input", attested: false, source_ids: [], origin_job_id: "j", first_seen: "2026-11-20T00:00:00Z" },
      { text: "生成試験作品", kind: "official_alt", attested: true, source_ids: [], origin_job_id: "j", first_seen: "2026-11-20T00:00:00Z" },
    ],
    medium: "novel",
    creators: ["作者甲"],
    genres: [],
    tags: [],
    first_release_year: 2001,
    publish_mode: "Public",
    history: [{ at: "2026-11-20T00:00:00Z", event: "created", job_id: "j" }],
    first_published_at: null,
    updated_at: null,
    created_at: "2026-11-20T00:00:00Z",
  };
}

/** Writes works/<id>/ under `worksDir` with nkg, validation, sources, raw texts, claims, work.json. Returns the work dir. */
export function makeGenWork(worksDir: string): string {
  const dir = path.join(worksDir, GEN_WORK_ID);
  mkdirSync(path.join(dir, "nkg"), { recursive: true });
  mkdirSync(path.join(dir, "research", "raw"), { recursive: true });
  const nkg = genNkg();
  writeFileSync(path.join(dir, "nkg", "nkg.json"), JSON.stringify(nkg, null, 2));
  writeFileSync(path.join(dir, "nkg", "validation.json"), JSON.stringify(genValidation(nkg), null, 2));
  writeFileSync(path.join(dir, "research", "sources.json"), JSON.stringify(genCards(), null, 2));
  writeFileSync(path.join(dir, "research", "claims.json"), JSON.stringify(genClaims(), null, 2));
  writeFileSync(path.join(dir, "research", "raw", "s000000001.txt"), `公式の紹介文。${COPIED_SENTENCE}そのほかの説明が続く。`);
  writeFileSync(path.join(dir, "research", "raw", "s000000002.txt"), "事典の本文。人物甲と人物乙の関係が説明されている。");
  writeFileSync(path.join(dir, "work.json"), JSON.stringify(genWork(), null, 2));
  return dir;
}

export function genContext(dir: string, luna: ModelPort, haiku: ModelPort, now = "2026-11-23T01:00:00Z", logs: string[] = []): StageContext {
  return {
    jobId: "job-gen-test",
    workDir: dir,
    workId: GEN_WORK_ID,
    range: [{ unit: "whole", from: null, to: null, label: "全体" }],
    luna,
    haiku,
    fetcher: { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) },
    budget: { limits: { searches: 40, fetches: 60, wallMs: 1 }, searchesUsed: 0, fetchesUsed: 0, startedAt: "2026-11-23T00:00:00+09:00" },
    now: () => new Date(now),
    log: (m) => logs.push(m),
  };
}
