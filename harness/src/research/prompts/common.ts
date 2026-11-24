/** Shared prompt fragments for S1 (WP-1.3). */

/** Mandatory instruction (REQUIREMENTS §1.3 / PLAN §0). Must appear in every claim-producing prompt. */
export const OWN_WORDS_RULE = "事実・関係・因果を自分の言葉で主張に分解せよ。出典の文を写すな";

/** Aspect vocabulary shown to the models (REQUIREMENTS §2.4). */
export const ASPECT_GUIDE = [
  "bibliographic = 書誌（作者・出版社/製作・初出年・巻数/話数・媒体）",
  "title = 正式名称・別名・原題",
  "genre = ジャンル・形式",
  "plot = 粗筋の出来事（作中で起きた1つの出来事: 誰が・何をして・どうなったか。各話・各章の筋）",
  "M01 = 人物と人物/勢力の関係、その変化",
  "M02 = 結末とその理由（なぜそうなったか）",
  "M03 = 出来事の因果（AがBを引き起こした）",
  "M04 = 実際の時系列と、物語上で明かされる順の違い",
  "M05 = 秘密・誰が何を知っているか",
  "M06 = 人物の動機・目的・恐れ・信念",
  "M07 = 人物の変化（初期状態→最終状態）",
  "M08 = 世界観・ルール・能力・制度",
  "M09 = 伏線と回収（手掛かりの機能）",
  "M10 = テーマ・問い・価値の対立",
  "M11 = 感情の流れ（フェーズごと）",
  "M12 = 文化的文脈（受容・受賞・影響・批評・論争）",
].join("\n");

export interface WorkBrief {
  title: string;
  creators: string[];
  medium: string;
  first_release: string | null;
  /** AMENDMENT 16: scope instruction built from the job range (null = the whole work). */
  scope?: string | null;
}

/** Structural minimum of a range item (avoids an import cycle with job/context.ts). */
export interface RangeLike {
  unit: string;
  from: number | null;
  to: number | null;
  label: string;
}

/**
 * AMENDMENT 16: the job range as an instruction for search / extraction prompts.
 * Returns null when the range covers the whole work (unit whole only, or an installment selector —
 * an installment picks the work itself at identification, so research then covers that work wholly).
 * Before A16 the range was parsed and stored but no stage prompt ever read it, so a ranged job
 * silently researched the whole work (HUNTER×HUNTER "ハンター試験編", job 20261124-0003).
 */
export function scopeText(range: readonly RangeLike[] | null | undefined): string | null {
  const items = (range ?? []).filter((i) => i.unit !== "whole" && i.unit !== "installment");
  if (items.length === 0) return null;
  const labels = items.map((i) => i.label).join("・");
  const lines = [
    `指定範囲「${labels}」のみが対象。それ以外の部分（範囲の前後の展開、他の編・巻・話・シーズン、続編・後日談、範囲外で判明する設定・人物の最終的な変化・作品全体の結末）は対象外であり、検索・抽出・記述のいずれにも含めない。`,
  ];
  if (items.some((i) => i.unit === "arc")) lines.push("編の範囲は、その編の発端から決着までとし、作品全体の結末と混同しない。範囲の終端はその編の決着である。");
  if (items.some((i) => i.unit === "volume" || i.unit === "episode" || i.unit === "season")) lines.push("範囲の境界（巻数・話数・シーズン）が曖昧な情報は、範囲内と確認できるものだけを対象にする。");
  return lines.join("\n");
}

export function workLine(w: WorkBrief): string {
  const parts = [`題名: ${w.title}`, `作者/製作: ${w.creators.join("、") || "不明"}`, `媒体: ${w.medium}`];
  if (w.first_release) parts.push(`初出: ${w.first_release}`);
  const line = parts.join(" / ");
  return w.scope ? `${line}\n対象範囲: ${w.scope}` : line;
}
