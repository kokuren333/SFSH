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
}

export function workLine(w: WorkBrief): string {
  const parts = [`題名: ${w.title}`, `作者/製作: ${w.creators.join("、") || "不明"}`, `媒体: ${w.medium}`];
  if (w.first_release) parts.push(`初出: ${w.first_release}`);
  return parts.join(" / ");
}
