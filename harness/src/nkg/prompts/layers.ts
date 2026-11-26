/** Prompts for S2 phases / fact layer / interpretive layer and their review + revision (WP-1.5). */
import type { Claim } from "../../research/claimTypes.ts";
import type { ElementSpec } from "../elements.ts";
import { AUTHORING_RULES, LENGTH_TARGETS, REVIEW_RULES, formatClaims, formatPhases } from "./common.ts";

// ---------------- phases ----------------
export const PHASES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["phases"],
  properties: {
    phases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "order", "scope", "claim_refs"],
        properties: {
          label: { type: "string" },
          order: { type: "integer" },
          scope: { type: "string" },
          claim_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface PhasesOutput {
  phases: { label: string; order: number; scope: string; claim_refs: string[] }[];
}

export function phasesPrompt(input: { title: string; claims: Claim[]; preferMore: boolean; coverage: string }): string {
  return `あなたは物語作品の構造化担当です。作品「${input.title}」（範囲: ${input.coverage}）の進行を「フェーズ」に分けてください。

# 規則
- フェーズは${input.preferMore ? "5〜7" : "3〜7"}個。最低でも「序盤／中盤／結末」に当たる区切りを含める。
- 場面単位にしない。物語の大きな局面の転換で区切る。
- label は日本語で12字以内（例: 序盤、事件発生、反転、結末）。order は1始まりの連番。
- scope はそのフェーズで何が変わるかを自分の言葉で60字以内。台詞や場面の再現は書かない。出典の文を写さない。
- claim_refs にそのフェーズの根拠 claim の ID を入れる。根拠は下の claim だけ。

# 調査済み claim
${formatClaims(input.claims)}
`;
}

export function phasesReviewPrompt(input: { title: string; phases: { id: string; label: string; scope: string }[]; claims: Claim[] }): string {
  return `作品「${input.title}」のフェーズ分割をレビューしてください。

# フェーズ案
${input.phases.map((p) => `- ${p.id}: ${p.label} — ${p.scope}`).join("\n")}

${REVIEW_RULES}
- 観点: 3〜7個か、序盤／中盤／結末を含むか、場面単位になっていないか、claim と矛盾しないか。target_id はフェーズ ID。

# 調査済み claim
${formatClaims(input.claims, 200)}
`;
}

// ---------------- authoring ----------------
export function authoringPrompt(input: {
  layer: "fact" | "interp";
  title: string;
  coverage: string;
  group: string;
  specs: ElementSpec[];
  phases: { id: string; label: string; order: number }[];
  claims: Claim[];
  existing: { id: string; type: string; label: string }[];
  hints: string[];
}): string {
  const book = input.specs.some(s=>s.module.startsWith("B"));
  const role = book ? "あなたは非物語書籍のBKG構造化担当です。中心命題・論証・概念・証拠・著者と文脈・批判・留保を整理します。人物や結末へ変換しない。著者の主張と実証済みの事実とハーネス解釈をstanceで分離。予測は予測とする。テーマも論点として記述する。" :
    input.layer === "fact"
      ? "あなたは事実層の担当です。調査済み claim を物語の構造（人物・出来事・因果・秘密・世界のルール・文脈）へ整理します。新しい事実を足さず、claim にあることだけを構造化してください。"
      : "あなたは解釈層の担当です。事実層のノードと claim をもとに、結末に至る理由・動機・変容・テーマ・感情の流れを分析し、独自の言葉で批評的に構成します。分析は based_on に根拠ノードを挙げてください。";
  const types = input.specs.map((s) => `- ${s.key}（${s.kind}、ID 接頭辞 "${s.idPrefix}"）: ${s.guide}`).join("\n");
  const existing = input.existing.length
    ? input.existing.map((e) => `- ${e.id} [${e.type}] ${e.label}`).join("\n")
    : "- （まだありません）";
  return `${role}
作品「${input.title}」（範囲: ${input.coverage}）。今回の担当グループ: ${input.group}

${AUTHORING_RULES}

${LENGTH_TARGETS}

# 作る要素（出力のキーごと）
${types}

# ID とつなぎ方
- 各要素の id は接頭辞＋2桁連番（例 ${input.specs[0]?.idPrefix ?? "xx"}01）。既存 ID と重ねない。
- エッジ（from/to を持つ要素）は既存ノードか、今回作るノードの ID を指す。
- 該当する claim が無い型は空配列にする。数を埋めるために作らない。
${input.hints.length ? `\n# この作品での重点\n${input.hints.map((h) => `- ${h}`).join("\n")}\n` : ""}
# フェーズ
${formatPhases(input.phases)}

# 既存ノード（参照してよい）
${existing}

# 調査済み claim
${formatClaims(input.claims)}
`;
}

// ---------------- review / revision ----------------
export function layerReviewPrompt(input: { layer: "fact" | "interp"; title: string; elements: unknown; claims: Claim[]; context: { id: string; type: string; label: string }[] }): string {
  const focus =
    input.layer === "fact"
      ? "事実層（claim の構造化）。各要素が claim_refs の claim に支えられているか、claim に無い事実を足していないか、場面の再現や出典の言い回しになっていないか、epistemic の区分が正しいかを見てください。"
      : "解釈層（分析・批評）。分析が根拠ノードと claim から飛躍しすぎていないか、canon/consensus/fan_theory/sfsh_analysis の区分が正しいか、場面の再現や出典の言い回しになっていないか、クイズが暗記問題になっていないかを見てください。";
  return `作品「${input.title}」の NKG ${focus}

${REVIEW_RULES}

# 参照できる他層のノード
${input.context.map((e) => `- ${e.id} [${e.type}] ${e.label}`).join("\n") || "- （なし）"}

# レビュー対象（JSON）
${JSON.stringify(input.elements)}

# 調査済み claim
${formatClaims(input.claims)}
`;
}

export function revisionPrompt(input: {
  layer: "fact" | "interp";
  title: string;
  elements: unknown;
  findings: { finding_id: string; target_id: string; type: string; severity: string; evidence: string }[];
  claims: Claim[];
}): string {
  return `あなたは作品「${input.title}」の NKG ${input.layer === "fact" ? "事実層" : "解釈層"}の作成者です。レビュー指摘に1回だけ対応してください。

${AUTHORING_RULES}

${LENGTH_TARGETS}

# 対応の仕方
- すべての指摘に responses で答える: action は revised（直した）か declined（直さない）。reason は自分の言葉で80字以内。
- 直した要素は updated の該当キーに「修正後の要素全体」を同じ id で入れる。直さない要素は入れない。
- missing への対応で要素を足す場合は新しい id で updated に入れる。
- misclassified／overreach の指摘は、まず epistemic を sfsh_analysis に変える・based_on を足す・表現を弱めるなどで直す。削除（removed_ids に id を入れる。その指摘は revised として答える）は、claim_refs も based_on も成り立たない要素に限る。
- copied_phrase / too_concrete の指摘は、自分の言葉で抽象化し直すこと。

# 指摘
${input.findings.map((f) => `- ${f.finding_id} [${f.type}/${f.severity}] 対象 ${f.target_id}: ${f.evidence}`).join("\n")}

# 現在の要素（JSON）
${JSON.stringify(input.elements)}

# 調査済み claim
${formatClaims(input.claims)}
`;
}
