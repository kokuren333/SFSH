/** Shared prompt fragments for S2 (NKG). Kept separate so prompts can be reviewed on their own. */
import type { Claim } from "../../research/claimTypes.ts";

/** Rules every authoring prompt must carry (PLAN §0, REQUIREMENTS §1.3 / C-2 / C-3 / C-7). */
export const AUTHORING_RULES = `# 執筆規則（必ず守る）
- 物語を場面順に並べ直さない。人物・因果・テーマへ抽象化して構造化する。
- すべて自分の言葉で書く。出典の文を写さない（言い回しの流用も不可）。事実・関係・因果を自分の言葉で主張に分解して使う。
- 台詞・せりふの引用、場面の再現、描写の言い換え、原文の転記を一切含めない。固有名（作品名・人名・用語）は可。
- ラベルと本文はすべて日本語。
- 根拠は与えられた claim だけ。各要素の claim_refs に根拠 claim の ID を必ず入れる。分析・推論の要素は based_on に根拠ノード ID を入れる。
- claim_refs も based_on も空の要素は採用されない（モデルの記憶だけを根拠にしない）。分からないことは作らずに省く。
- claim_refs には、その要素を支える claim を漏れなく入れる（目安 3〜8 件）。同じ事実を別の出典の claim も述べていれば併記し、出典ティア（T1 公式 > T2 専門 > T3 百科事典型 > T4 ファンサイト）の高い claim を優先して含める。T4 の claim だけを根拠にした要素は信頼度が低く公開されない。
- 非物語BKGでは、以下の物語専用語（人物・出来事・結末）は適用しない。canonは著者がその主張を述べた/当該資料がその事実を報告したという確認。主張自体の実証とは別。harness_interpretationはsfsh_analysis＋based_on。spoilerはnone。
- epistemic: canon=作品内の確定事実／consensus=批評・受容で広く共有された見方／fan_theory=ファンの考察／sfsh_analysis=あなた自身の分析（based_on 必須）。
- spoiler: none／mid（中盤の展開）／ending（結末に関わる）。phase_ref はフェーズ ID（不明なら null）。
- 推論でつながる結びつき（出来事どうしの因果、人物どうしの関係など）で、1つの claim が直接は述べていないが複数の claim から導けるものは、省かずに epistemic: sfsh_analysis とし、based_on に両端のノード ID、claim_refs に両端の根拠 claim を入れる。claim が直接述べているものだけ canon／consensus にする。`;

/** Target lengths per field (soft, §2.1 / §2.4). */
export const LENGTH_TARGETS = `# 長さの目安
- label: 20字前後（最大40字）
- summary: 80〜160字
- analysis: 200〜400字（解釈層のみ。事実層は null でよい）
- その他の文字列項目（question, answer, consequence, meaning, why_famous など）: 60〜120字`;

export function formatClaims(claims: Claim[], limit = 600): string {
  const lines = claims.slice(0, limit).map((c) => {
    const tier = (c as Claim & { best_tier?: string }).best_tier;
    const tags = [tier ?? null, c.epistemic, `phase:${c.phase_hint}`, c.story_unit ? `unit:${c.story_unit}` : null, c.spoiler !== "none" ? `spoiler:${c.spoiler}` : null].filter(Boolean).join(", ");
    return `- ${c.claim_id} [${(c.aspects ?? []).join(",")}] (${tags}) ${c.text}`;
  });
  if (claims.length > limit) lines.push(`（ほか ${claims.length - limit} 件省略）`);
  return lines.join("\n");
}

export function formatPhases(phases: { id: string; label: string; order: number }[]): string {
  return phases.map((p) => `- ${p.id}: ${p.label}`).join("\n");
}

/** Review instructions shared by both directions (REQUIREMENTS §3.3: findings only, no rewriting). */
export const REVIEW_RULES = `# レビュー規則
- あなたはレビュー役です。成果物を書き換えず、指摘（findings）だけを返してください。
- type は次のいずれか:
  unsupported（claim が支持しない）／overreach（推論過剰）／too_concrete（場面の再現に近い）／
  copied_phrase（出典・原作の言い回しの写し）／misclassified（epistemic などの区分誤り）／
  missing（重要な要素の欠落）／contradiction（他の要素や claim との矛盾）
- target_id は対象要素の ID。missing で対象が無い場合は "layer"。
- evidence は自分の言葉で短く（120字以内）。根拠 claim の ID があれば含める。引用はしない。
- epistemic が sfsh_analysis と明示された推論（based_on が両端を指す因果・関係など）は、それだけでは overreach としない。直接の根拠が無いのに canon／consensus になっている要素は、削除ではなく sfsh_analysis への変更を求める misclassified として指摘する。
- 問題が無ければ findings は空配列。`;
