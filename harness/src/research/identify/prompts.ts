/** S0 identification prompts and OpenAI-strict output schemas (luna). */

export const IDENTIFY_MEDIA = ["book", "novel", "manga", "anime", "film", "drama", "game", "other"] as const;
export type IdentifyMedium = (typeof IDENTIFY_MEDIA)[number];

export const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selections"],
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "why", "tier_suggested"],
        properties: {
          url: { type: "string" },
          why: { type: "string" },
          tier_suggested: { type: ["string", "null"], enum: ["T1", "T2", "T3", "T4", "T5", null] },
        },
      },
    },
  },
} as const;

export interface SearchOutput {
  selections: { url: string; why: string; tier_suggested: "T1" | "T2" | "T3" | "T4" | "T5" | null }[];
}

export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "title_original", "title_reading", "medium", "kind", "kind_reason", "kind_evidence", "creators", "first_release_year", "evidence", "aliases_seen"],
        properties: {
          title: { type: "string" },
          title_original: { type: ["string", "null"] },
          title_reading: { type: ["string", "null"] },
          medium: { type: "string", enum: [...IDENTIFY_MEDIA] },
          kind: { type: ["string", "null"], enum: ["fiction", "nonfiction", "mixed", null] },
          kind_reason: { type: "string" },
          kind_evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["source_id", "quote"], properties: { source_id: { type: "string" }, quote: { type: "string" } } } },
          creators: { type: "array", items: { type: "string" } },
          first_release_year: { type: ["integer", "null"] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["source_id", "quote"],
              properties: { source_id: { type: "string" }, quote: { type: "string" } },
            },
          },
          aliases_seen: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "kind", "source_id", "quote"],
              properties: {
                text: { type: "string" },
                kind: { type: "string", enum: ["official_alt", "common"] },
                source_id: { type: "string" },
                quote: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ExtractedCandidate {
  kind?: "fiction" | "nonfiction" | "mixed" | null;
  kind_reason?: string;
  kind_evidence?: { source_id: string; quote: string }[];
  title: string;
  title_original: string | null;
  title_reading: string | null;
  medium: IdentifyMedium;
  creators: string[];
  first_release_year: number | null;
  evidence: { source_id: string; quote: string }[];
  aliases_seen: { text: string; kind: "official_alt" | "common"; source_id: string; quote: string }[];
}

export interface ExtractOutput {
  candidates: ExtractedCandidate[];
}

export function buildSearchPrompt(workQuery: string, mediumHint: string | null, maxSearches: number, maxSelections: number, installment: number | null = null): string {
  return [
    "あなたは作品同定のための調査員です。入力された作品名は検索語であり、正式名称とは限りません（略称・通称・打ち間違いの可能性があります）。",
    "",
    `入力: ${JSON.stringify(workQuery)}`,
    `媒体の手がかり: ${mediumHint ?? "なし"}`,
    ...(installment != null ? [`対象: シリーズの第${installment}作目に当たる個別作品（続編）。第1作そのものではなく、第${installment}作目の正式題名・媒体・制作者・初出年が分かるページを探すこと。`] : []),
    "",
    "やること:",
    `1. web_search を最大 ${maxSearches} 回まで使い、この作品の正式な題名・媒体・種別（創作/非創作/混合）・作者（制作者）・初出年・題名の読みを記載しているページを探す。`,
    "   優先順: 公式サイト・出版社/製作会社のページ（T1）、国会図書館などの書誌データベース（T1）、新聞・専門誌（T2）、百科事典型サイト（T3）。",
    "   同名の別作品や媒体違い（原作小説とアニメ化など）があれば、それぞれの根拠ページも含める。",
    `2. 本文を取得すべきページを最大 ${maxSelections} 件選び、selections に入れる。url は検索結果に表示された URL をそのまま書く。検索結果に無い URL（記憶から書いた URL）は書かない。`,
    "3. why には選んだ理由を短く自分の言葉で書く。tier_suggested には T1〜T5 の見立て（不明なら null）。",
    "",
    "禁止: 海賊版・違法アップロード・全文転載サイト・ペイウォール回避。記憶だけで答えない（根拠はページ本文でのみ確認する）。",
  ].join("\n");
}

export interface ExtractSource {
  source_id: string;
  tier: string;
  site_key: string;
  title: string;
  url: string;
  text: string;
}

export function buildExtractPrompt(workQuery: string, mediumHint: string | null, sources: ExtractSource[], installment: number | null = null): string {
  const blocks = sources.map((s) =>
    [`=== source_id: ${s.source_id} | tier: ${s.tier} | site: ${s.site_key} | title: ${s.title} | url: ${s.url}`, s.text, "=== end"].join("\n"),
  );
  return [
    "あなたは作品同定の抽出係です。下の取得済みページ本文だけを根拠に、入力が指す作品の候補を抽出してください。",
    "あなたの記憶や知識だけを根拠にした候補・項目は出さないこと（本文に書かれていないことは null か空配列にする）。",
    "事実・関係・因果は自分の言葉で扱い、出典の文を写さないこと。ただし evidence.quote と aliases_seen.quote だけは、照合用に本文から短く（80字以内）そのまま抜き出す。",
    "",
    `入力（検索語。正式名称とは限らない）: ${JSON.stringify(workQuery)}`,
    `媒体の手がかり: ${mediumHint ?? "なし"}`,
    ...(installment != null ? [`対象: シリーズの第${installment}作目に当たる個別作品（続編）。候補はその作品だけにし、第1作やシリーズ全体は候補にしない。`] : []),
    "",
    "正式名称（title）の決め方:",
    "- T1 出典（公式・出版社・書誌DB）が表記している題名を、その表記のまま使う（記号・全角半角も本文どおり）。T1 が無ければ他の出典の表記。",
    "- 副題・巻次・話数・「劇場版」「TVアニメ」等の接頭辞は含めない。",
    "- 日本語の公式題名があればそれを title、原語の題名を title_original（無ければ null）。",
    "",
    "各候補の項目:",
    "- title_reading: 題名の読みをひらがなで、語の切れ目に半角スペースを入れる（例: \"まほうしょうじょ まどか まぎか\"）。本文に読みが無くても推定して書いてよい。分からなければ null。",
    "- medium: book / novel / manga / anime / film / drama / game / other。書籍一般はbook。小説と確認できた場合だけnovel。書籍というだけでnovelにしない。",
    "- kind: 媒体と別にfiction（創作物語）/nonfiction（論説・教養・歴史・科学等）/mixed（物語的ノンフィクション、両方必要）。kind_reasonは根拠を自分の言葉で。kind_evidenceはその種別が確認できる出典の短い照合用抜粋。判定不能ならkind=null、推測でfictionへ倒さない。",
    "- creators: 本文に書かれた作者・原作者・監督・制作会社など。",
    "- first_release_year: 本文に書かれたその媒体での初出年（西暦の整数）。無ければ null。",
    "- evidence: その候補の題名を含む本文の短い抜き出し（quote は title の文字列をそのまま含むこと）と source_id。できるだけ多くの出典から。",
    "- aliases_seen: 本文に書かれた別題・旧題・公式略称（official_alt）や通称（common）。quote はその別名の文字列をそのまま含む短い抜き出し。",
    "",
    "同じ題名でも媒体が違う（原作小説とアニメなど）場合や、同名の別作品がある場合は、別々の候補として出す。入力に当てはまる作品が本文に無ければ candidates は空配列。",
    "",
    ...blocks,
  ].join("\n");
}
