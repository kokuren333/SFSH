/** Fixture work dir + canned S2 model outputs for tests (no network, no real work data). */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StageContext } from "../job/context.ts";
import type { ModelPort, ModelRequest } from "../model/types.ts";
import type { Claim } from "../research/claimTypes.ts";
import type { SourceCard } from "../research/types.ts";
import { fillGroup, mEdge, mNode } from "./testFixtures.ts";

function card(source_id: string, tier: SourceCard["tier"], site: string): SourceCard {
  return {
    source_id,
    url: `https://${site}/w`,
    final_url: `https://${site}/w`,
    title: `${site} page`,
    publisher: site,
    domain: site,
    site_key: site,
    tier,
    tier_basis: "table",
    license: null,
    fetched_at: "2026-11-23T10:00:00+09:00",
    content_hash: "sha256:00",
    raw_text_path: `research/raw/${source_id}.txt`,
    text_chars: 100,
    excerpts: [{ text: "検証用抜粋（非公開）", offset: 0, claim_ids: ["c0001"] }],
    origin: { kind: "instruction", note: "test" },
  };
}

export const WORK_SOURCES: SourceCard[] = [card("s1", "T1", "pub.example"), card("s2", "T3", "wiki.example"), card("s3", "T4", "fan.example")];

type Spec = [string, string[], string[], Claim["epistemic"]?, Claim["status"]?];
const CLAIM_SPEC: Spec[] = [
  ["c0001", ["genre"], ["s1"]],
  ["c0002", ["bibliographic"], ["s1"]],
  ["c0003", ["M01"], ["s1", "s2"]],
  ["c0004", ["M01"], ["s1"]],
  ["c0005", ["M01", "M03"], ["s2"]],
  ["c0006", ["M03"], ["s1"]],
  ["c0007", ["M03", "M04"], ["s1"]],
  ["c0008", ["M03"], ["s2"]],
  ["c0009", ["M05"], ["s1"]],
  ["c0010", ["M05"], ["s2"]],
  ["c0011", ["M05"], ["s3"], "consensus"],
  ["c0012", ["M04"], ["s1"]],
  ["c0013", ["M04"], ["s2"]],
  ["c0014", ["M02"], ["s1"]],
  ["c0015", ["M02"], ["s2"]],
  ["c0016", ["M02"], ["s3"]],
  ["c0017", ["M06"], ["s2"]],
  ["c0018", ["M06"], ["s3"]],
  ["c0019", ["M06"], ["s1"]],
  ["c0020", ["M07"], ["s1"]],
  ["c0021", ["M07"], ["s2"]],
  ["c0022", ["M08"], ["s1"]],
  ["c0023", ["M08"], ["s2"]],
  ["c0024", ["M10"], ["s1"]],
  ["c0025", ["M10"], ["s2"]],
  ["c0026", ["M10"], ["s3"]],
  ["c0027", ["M12"], ["s1"]],
  ["c0028", ["M12"], ["s2"], "consensus"],
  ["c0029", ["M12"], ["s3"], "fan_theory"],
  ["c0030", ["M11"], ["s1"]],
  ["c0031", ["M11"], ["s2"]],
  ["c0032", ["M11"], ["s3"]],
  ["c0033", ["M01"], ["s1"], "canon", "dropped"],
  ["c0034", ["M09"], ["s9"]], // source without a card → unusable
];

export function fixtureClaims(): Claim[] {
  return CLAIM_SPEC.map(([claim_id, aspects, source_ids, epistemic, status]) => ({
    claim_id,
    text: `主張 ${claim_id}（自分の言葉による要約）`,
    source_ids,
    evidence: source_ids.map((s) => ({ source_id: s, offset: 0, length: 4 })),
    aspects,
    epistemic: epistemic ?? "canon",
    phase_hint: "whole",
    spoiler: "none",
    entities: [],
    authored_by: "luna",
    reviewed_by: "haiku",
    review: "agreed",
    status: status ?? "active",
    drop_reason: status === "dropped" ? "review_unsupported" : null,
  }));
}

export function makeFixtureWork(dir: string): void {
  mkdirSync(path.join(dir, "research"), { recursive: true });
  writeFileSync(path.join(dir, "research", "claims.json"), JSON.stringify(fixtureClaims(), null, 2));
  writeFileSync(path.join(dir, "research", "sources.json"), JSON.stringify(WORK_SOURCES, null, 2));
  writeFileSync(
    path.join(dir, "work.json"),
    JSON.stringify({
      work_id: "novel-test-work-2000",
      title: "試験作品",
      medium: "novel",
      creators: ["作者甲"],
      aliases: [
        { text: "試験", kind: "common", attested: true, source_ids: ["s2"] },
        { text: "しけん", kind: "input", attested: false, source_ids: [] },
      ],
      publish_mode: "Public",
    }),
  );
}

export function fixtureContext(dir: string, luna: ModelPort, haiku: ModelPort, logs: string[] = []): StageContext {
  return {
    jobId: "job-test",
    workDir: dir,
    workId: "novel-test-work-2000",
    range: [{ unit: "whole", from: null, to: null, label: "全体" }],
    luna,
    haiku,
    fetcher: { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) },
    budget: { limits: { searches: 40, fetches: 60, wallMs: 1 }, searchesUsed: 0, fetchesUsed: 0, startedAt: "2026-11-23T00:00:00+09:00" },
    now: () => new Date("2026-11-23T01:00:00Z"),
    log: (m) => logs.push(m),
  };
}

/** Canned outputs for the full S2 chain on the fixture work. */
/** Findings listed in an S2 revision prompt ("- r1f01 [type/severity] 対象 <id>: ..."). */
function revisionFindings(prompt: string): { id: string; target: string }[] {
  return [...prompt.matchAll(/^- (r\d+f\d+) \[[^\]]+\] 対象 (\S+?):/gm)].map((m) => ({ id: m[1]!, target: m[2]! }));
}

export function cannedS2(req: ModelRequest): unknown {
  const g = (partial: Record<string, unknown[]>) => fillGroup(req.schema, partial);
  const gu = (partial: Record<string, unknown[]>) => fillGroup((req.schema as { properties: { updated: object } }).properties.updated, partial);
  switch (req.task) {
    case "s2.genre":
      return {
        genres: [
          { genre: "mystery", reason: "謎解きが中心", claim_refs: ["c0001"] },
          { genre: "推理小説", reason: "語彙外", claim_refs: ["c0001"] },
          { genre: "人間ドラマ", reason: "人物の葛藤", claim_refs: ["c0003"] },
        ],
      };
    case "s2.modules.review":
      return {
        additional_pages: [],
        additions: [
          { module: "M08", reason: "制度が効く (c0022)" },
          { module: "M02", reason: "常時オン" },
          { module: "M99", reason: "不正" },
        ],
        removals: [
          { module: "M99", reason: "不正な除外" },
          { module: "M11", reason: "感情曲線は弱い" },
        ],
      };
    case "s2.phases":
      return {
        phases: [
          { label: "結末", order: 3, scope: "真相の開示", claim_refs: ["c0007"] },
          { label: "序盤", order: 1, scope: "事件の発生", claim_refs: ["c0006"] },
          { label: "中盤", order: 2, scope: "関係の決裂", claim_refs: ["c0008", "c9999"] },
        ],
      };
    case "s2.phases.review":
      return { findings: [] };
    case "s2.fact.events":
      return g({
        events: [
          mNode({ id: "ev01", label: "事件発生", claim_refs: ["c0006"], phase_ref: "ph1", story_order: 1, disclosure_phase: "ph1" }),
          mNode({ id: "ev02", label: "真相の露見", claim_refs: ["c0007"], phase_ref: "ph3", spoiler: "ending", story_order: 3, disclosure_phase: "ph3" }),
          mNode({ id: "ev03", label: "盟友の決裂", claim_refs: ["c0008"], phase_ref: "ph2", spoiler: "mid", story_order: 2, disclosure_phase: "ph2" }),
        ],
        causes: [
          mEdge({ id: "cs01", from: "ev01", to: "ev03", kind: "causes", claim_refs: ["c0006"] }),
          mEdge({ id: "cs02", from: "ev03", to: "ev02", kind: "enables", claim_refs: ["c0008"] }),
        ],
      });
    case "s2.fact.people":
      return g({
        characters: [
          mNode({ id: "ch01", label: "人物甲", claim_refs: ["c0003"] }),
          mNode({ id: "ch02", label: "人物乙", claim_refs: ["c0003", "c0004"] }),
          mNode({ id: "ch03", label: "探偵丙", claim_refs: ["c0005"] }),
          mNode({ id: "ch09", label: "記憶だけの人物", claim_refs: ["c9999"] }),
          mNode({ id: "ch10", label: "棄却済み claim の人物", claim_refs: ["c0033"] }),
        ],
        relations: [
          mEdge({ id: "rl01", from: "ch01", to: "ch02", kind: "盟友", valence: "positive", phase_from: "ph1", phase_to: "ph2", changed_by: "ev03", claim_refs: ["c0003"] }),
          mEdge({ id: "rl02", from: "ch02", to: "ch01", kind: "敵対", valence: "negative", phase_from: "ph2", phase_to: null, changed_by: "ch03", claim_refs: ["c0004"] }),
        ],
        secrets: [mNode({ id: "se01", label: "乙の正体", claim_refs: ["c0009"], spoiler: "ending" })],
        knows: [
          mEdge({ id: "kn01", from: "ch01", to: "se01", holder: "ch01", phase: "ph1", state: "unknown", claim_refs: ["c0010"] }),
          mEdge({ id: "kn02", from: "audience", to: "se01", holder: "audience", phase: "ph2", state: "suspects", claim_refs: ["c0011"], epistemic: "consensus" }),
        ],
      });
    case "s2.fact.world":
      return g({
        contexts: [
          mNode({ id: "cx01", label: "文学賞受賞", kind: "award", claim_refs: ["c0027"] }),
          mNode({ id: "cx02", label: "批評での評価", kind: "reception", claim_refs: ["c0028"], epistemic: "consensus" }),
        ],
        about: [mEdge({ id: "ab01", from: "cx01", to: "work", claim_refs: ["c0027"] })],
      });
    case "s2.fact.review": {
      // A14: the review runs per call group — findings only for the elements in this call (the missing-structure
      // finding comes from the people group's review)
      const has = (id: string) => req.prompt.includes(`"id":"${id}"`);
      return {
        findings: [
          ...(has("ev02") ? [{ target_id: "ev02", type: "too_concrete", severity: "low", evidence: "場面の説明に寄っている" }] : []),
          ...(has("ch02") ? [{ target_id: "ch02", type: "overreach", severity: "medium", evidence: "c0004 は裏切りの動機まで述べていない" }] : []),
          ...(has("ch01") ? [{ target_id: "layer", type: "missing", severity: "medium", evidence: "c0005 の組織が無い" }] : []),
        ],
      };
    }
    case "s2.fact.revise": {
      const fs = revisionFindings(req.prompt);
      const ev = fs.find((x) => x.target === "ev02");
      const lay = fs.find((x) => x.target === "layer");
      return {
        responses: fs.map((x) =>
          x.target === "ch02" ? { finding_id: x.id, action: "declined", reason: "c0003 と合わせれば支持される" } : { finding_id: x.id, action: "revised", reason: x.target === "layer" ? "組織を追加" : "抽象化した" },
        ),
        updated: gu({
          events: ev ? [mNode({ id: "ev02", label: "真相の開示", claim_refs: ["c0007"], phase_ref: "ph3", spoiler: "ending", story_order: 3, disclosure_phase: "ph3" })] : [],
          factions: lay ? [mNode({ id: "fa01", label: "探偵事務所", claim_refs: ["c0005"] })] : [],
        }),
        removed_ids: [],
      };
    }
    case "s2.interp.reverse_plot":
      return g({
        outcomes: [mNode({ id: "oc01", label: "盟友関係の終焉", claim_refs: ["c0014"], phase_ref: "ph3", spoiler: "ending" })],
        whys: [
          mNode({ id: "wy01", label: "乙の自己保存", level: "direct", factor_kind: "psychological", claim_refs: ["c0015"], based_on: ["ch02"] }),
          mNode({ id: "wy02", label: "信頼の非対称", level: "root", factor_kind: "social", epistemic: "consensus", based_on: ["wy01", "ev01"], analysis: "分析文" }),
        ],
        explains: [
          mEdge({ id: "xp01", from: "wy01", to: "oc01", refs: ["ev03", "zz99"], claim_refs: ["c0015"] }),
          mEdge({ id: "xp02", from: "wy02", to: "wy01", refs: [], epistemic: "sfsh_analysis", based_on: ["wy02"] }),
        ],
      });
    case "s2.interp.motives_arcs":
      return g({
        motives: [
          mNode({ id: "mo01", label: "生き延びたい", owner: "ch02", kind: "goal", phase_from: "ph1", phase_to: "ph3", claim_refs: ["c0017"] }),
          mNode({ id: "mo02", label: "友を信じる", owner: "ch01", kind: "belief", phase_from: null, phase_to: "ph9", claim_refs: ["c0019"] }),
          mNode({ id: "mo03", label: "幽霊の動機", owner: "ch99", kind: "fear", phase_from: null, phase_to: null, claim_refs: ["c0018"] }),
        ],
        drives: [mEdge({ id: "dr01", from: "mo01", to: "ev03", claim_refs: ["c0017"] })],
        conflicts: [mEdge({ id: "cw01", from: "mo01", to: "mo02", epistemic: "sfsh_analysis", based_on: ["mo01", "mo02"] })],
      });
    case "s2.interp.themes_emotion":
      return g({
        themes: [
          mNode({ id: "th01", label: "信頼の代償", question: "信頼は報われるか", values: ["信頼", "自己保存"], tension: "信じることと身を守ること", epistemic: "sfsh_analysis", based_on: ["ch01", "ev03"], analysis: "初稿" }),
          mNode({ id: "th02", label: "根拠のない主題", question: "?", values: [], tension: "?", epistemic: "sfsh_analysis" }),
        ],
        embodies: [mEdge({ id: "em01", from: "ch01", to: "th01", epistemic: "sfsh_analysis", based_on: ["th01"] })],
      });
    case "s2.interp.extras":
      return g({
        iconic_moments: [mNode({ id: "im01", label: "決裂の瞬間", event_ref: "ev03", why_famous: "受賞評で繰り返し言及される", context_refs: ["cx01", "ch01"], claim_refs: ["c0027"] })],
        interpretations: [
          mNode({
            id: "ip01",
            label: "乙の裏切りの意味",
            topic: "裏切りは必然だったか",
            claim_refs: [],
            positions: [
              { claim: "作中では自己保存として描かれる", epistemic: "canon", claim_refs: ["c0014"] },
              { claim: "最初から計画していたという考察", epistemic: "fan_theory", claim_refs: ["c0029"] },
              { claim: "根拠の無い立場", epistemic: "consensus", claim_refs: [] },
            ],
          }),
        ],
        quizzes: [
          mNode({ id: "qz01", label: "決裂の理由", question: "なぜ盟友関係は終わったか", answer: "乙が自己保存を選んだから", reasoning_refs: ["wy01", "ev03"], quiz_type: "causal", epistemic: "sfsh_analysis", based_on: ["wy01"] }),
          mNode({ id: "qz02", label: "根拠なし", question: "?", answer: "?", reasoning_refs: ["zz01"], quiz_type: "motive", claim_refs: ["c0014"] }),
        ],
      });
    case "s2.interp.review":
      return { findings: req.prompt.includes(`"id":"th01"`) ? [{ target_id: "th01", type: "overreach", severity: "low", evidence: "ev03 からの飛躍がある" }] : [] };
    case "s2.interp.revise": {
      const fs = revisionFindings(req.prompt);
      const th = fs.find((x) => x.target === "th01");
      return {
        responses: fs.map((x) => ({ finding_id: x.id, action: "revised", reason: "根拠に沿って弱めた" })),
        updated: gu({
          themes: th ? [mNode({ id: "th01", label: "信頼の代償", question: "信頼は報われるか", values: ["信頼", "自己保存"], tension: "信じることと身を守ること", epistemic: "sfsh_analysis", based_on: ["ch01", "ev03"], analysis: "修正稿" })] : [],
        }),
        removed_ids: [],
      };
    }
    default:
      return undefined;
  }
}
