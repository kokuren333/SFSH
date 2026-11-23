/** Prompts and schemas for S2 module selection (WP-1.4, REQUIREMENTS §2.5). */
import type { Claim } from "../../research/claimTypes.ts";
import { formatClaims } from "./common.ts";

export const GENRE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["genres"],
  properties: {
    genres: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["genre", "reason", "claim_refs"],
        properties: {
          genre: { type: "string" },
          reason: { type: "string" },
          claim_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface GenreOutput {
  genres: { genre: string; reason: string; claim_refs: string[] }[];
}

export function genrePrompt(input: { title: string; vocabulary: { slug: string; label: string }[]; claims: Claim[] }): string {
  return `あなたは物語作品の調査担当です。作品「${input.title}」のジャンルを、下の統制語彙の中からだけ選んでください。

# 統制語彙（slug: 表示名）
${input.vocabulary.map((g) => `- ${g.slug}: ${g.label}`).join("\n")}

# 規則
- genre には上の slug をそのまま書く。語彙に無いジャンルは書かない。
- 1〜4個。作品の中心にあるものから順に。
- reason は自分の言葉で60字以内。根拠 claim の ID を claim_refs に入れる。
- 根拠は下の claim だけ。モデルの記憶を根拠にしない。

# 調査済み claim
${formatClaims(input.claims)}
`;
}

export const MODULE_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["additions", "removals"],
  properties: {
    additions: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["module", "reason"], properties: { module: { type: "string" }, reason: { type: "string" } } },
    },
    removals: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["module", "reason"], properties: { module: { type: "string" }, reason: { type: "string" } } },
    },
  },
} as const;

export interface ModuleReviewOutput {
  additions: { module: string; reason: string }[];
  removals: { module: string; reason: string }[];
}

export const MODULE_DESCRIPTIONS: Record<string, string> = {
  M01: "人物関係グラフ（人物・勢力と、フェーズで変わる関係）",
  M02: "リバースプロット（結末を根とする「なぜ」の木）",
  M03: "因果グラフ（転換点となる出来事と因果）",
  M04: "時系列の二重化（実際の順序と開示の順序の差）",
  M05: "知識状態マトリクス（秘密と、誰がいつ何を知るか）",
  M06: "動機・欲望マップ",
  M07: "キャラクター変容",
  M08: "世界観・ルール（制約・能力・制度）",
  M09: "伏線・回収（手掛かりの機能と回収先）",
  M10: "テーマ・思想",
  M11: "感情曲線（フェーズ単位の感情の起伏）",
  M12: "文化的文脈（受容・受賞・影響）",
};

export function moduleReviewPrompt(input: {
  title: string;
  genres: { slug: string; label: string; reason: string }[];
  alwaysOn: string[];
  selectable: string[];
  enabled: string[];
  claimCounts: Record<string, number>;
  claims: Claim[];
}): string {
  const sel = input.selectable
    .map((m) => `- ${m} ${MODULE_DESCRIPTIONS[m]}: ${input.enabled.includes(m) ? "オン" : "オフ"}（関連 claim ${input.claimCounts[m] ?? 0} 件）`)
    .join("\n");
  return `あなたはレビュー役です。作品「${input.title}」の分析モジュール選択に過不足がないかを指摘してください。成果物は書き換えず、追加・削除の提案だけを返します。

# 判定されたジャンル
${input.genres.map((g) => `- ${g.label}（${g.slug}）: ${g.reason}`).join("\n") || "- （なし）"}

# 常時オン（変更不可）
${input.alwaysOn.map((m) => `- ${m} ${MODULE_DESCRIPTIONS[m]}`).join("\n")}

# ジャンルで選ぶモジュール（現在の展開結果）
${sel}

# 規則
- additions / removals に書けるのは上の「ジャンルで選ぶモジュール」の ID（${input.selectable.join(", ")}）だけ。
- 作品の性質から見て、オフだが必要なものは additions、オンだが不要なものは removals に入れる。
- reason は自分の言葉で80字以内。根拠になる claim の ID を含める。
- 過不足が無ければ両方とも空配列。

# 調査済み claim
${formatClaims(input.claims, 200)}
`;
}
