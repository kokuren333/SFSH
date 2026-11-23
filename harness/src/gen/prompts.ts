/**
 * S3 prompts and schemas (tags / page text / quiz). Luna-facing schemas are OpenAI-strict
 * (checked in tests with strictSchemaViolations); Haiku-facing ones are plain JSON Schema.
 */
import type { Claim } from "../research/claimTypes.ts";
import { formatClaims } from "../nkg/prompts/common.ts";
import { FINDING_TYPES, RESPONSES_SCHEMA, lastRoundNote, priorRoundsBlock, type Finding, type ReviewRound } from "../nkg/review.ts";
import type { VocabEntry } from "./io.ts";

const SPOILERS = ["none", "mid", "ending"] as const;

// ------------------------------------------------------------------ tags
export const TAG_FINDING_TYPES = ["unsupported", "spoiler", "not_attribute"] as const;
export type TagFindingType = (typeof TAG_FINDING_TYPES)[number];

const TAG_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "reason", "claim_refs"],
  properties: {
    slug: { type: "string" },
    reason: { type: "string" },
    claim_refs: { type: "array", items: { type: "string" } },
  },
} as const;

/** Luna (strict). */
export const TAGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tags"],
  properties: { tags: { type: "array", items: TAG_ITEM } },
} as const;

/** Haiku review of tags. */
export const TAG_FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_id", "type", "severity", "evidence"],
        properties: {
          target_id: { type: "string" },
          type: { type: "string", enum: [...TAG_FINDING_TYPES] },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

/** Luna (strict) revision of tags. */
export const TAG_REVISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["responses", "tags"],
  properties: { responses: RESPONSES_SCHEMA, tags: { type: "array", items: TAG_ITEM } },
} as const;

const vocabList = (v: VocabEntry[]) => v.map((t) => `- ${t.slug}: ${t.label}（${t.group ?? ""}）`).join("\n");

const TAG_RULES = `# タグの規則
- タグは作品の「属性」（題材・舞台・形式・受賞や展開）だけを表す。下の語彙リストの slug 以外は使わない（新しい語を作らない）。
- 最大8個。調査結果（claim）で裏づけられるものだけを選び、claim_refs に根拠 claim の ID を入れる。
- 展開・どんでん返し・結末・正体・死などを明かすタグ（ネタバレになるタグ）は付けない。作品の前提として序盤で示される属性だけにする。
- reason は自分の言葉で短く（60字以内）。出典の文を写さない。`;

export function tagsPrompt(o: { title: string; header: string; vocab: VocabEntry[]; claims: Claim[] }): string {
  return `あなたは物語作品の調査担当です。作品『${o.title}』に付けるタグを、統制語彙の中から提案してください。

${TAG_RULES}

# 作品の基本情報
${o.header}

# 統制語彙（slug: 表示名（区分））
${vocabList(o.vocab)}

# 調査結果（claim）
${formatClaims(o.claims)}
`;
}

export function tagsReviewPrompt(o: { title: string; tags: { slug: string; reason: string; claim_refs: string[] }[]; vocab: VocabEntry[]; claims: Claim[]; prior: ReviewRound[]; round: number; maxRounds: number }): string {
  return `あなたはレビュー役です。作品『${o.title}』に提案されたタグを点検し、指摘（findings）だけを返してください。タグを書き換えないでください。

# 指摘の種類（type）
- unsupported: claim がその属性を支持しない
- spoiler: 展開・結末・正体などを明かす（序盤で示される前提ではない）
- not_attribute: 作品の属性（題材・舞台・形式・受賞や展開）を表していない、または語彙の意味と合わない
- target_id はタグの slug。evidence は自分の言葉で短く（120字以内）。問題が無ければ findings は空配列。

${TAG_RULES}

# 統制語彙
${vocabList(o.vocab)}

# 提案されたタグ
${o.tags.map((t) => `- ${t.slug}: ${t.reason}（根拠: ${t.claim_refs.join(", ") || "なし"}）`).join("\n") || "（なし）"}

# 調査結果（claim）
${formatClaims(o.claims)}
${priorRoundsBlock(o.prior, o.round, o.maxRounds)}`;
}

export function tagsRevisePrompt(o: { title: string; tags: { slug: string; reason: string; claim_refs: string[] }[]; findings: Finding[]; vocab: VocabEntry[]; claims: Claim[]; round: number; maxRounds: number }): string {
  return `作品『${o.title}』のタグ提案にレビューの指摘が付きました。各指摘に revised（直した。タグを外した・差し替えた場合を含む）か declined（直さない。理由を書く）で答え、直したあとのタグ一覧全体を tags に入れてください。

${TAG_RULES}

# 統制語彙
${vocabList(o.vocab)}

# 現在のタグ
${o.tags.map((t) => `- ${t.slug}: ${t.reason}（根拠: ${t.claim_refs.join(", ") || "なし"}）`).join("\n") || "（なし）"}

# 指摘
${o.findings.map((f) => `- ${f.finding_id} [${f.type}] ${f.target_id}: ${f.evidence}`).join("\n")}

# 調査結果（claim）
${formatClaims(o.claims)}
${lastRoundNote(o.round, o.maxRounds)}`;
}

// ------------------------------------------------------------------ page text
/** Rules carried by every S3 writing / revision / rewrite prompt (C-2, C-3, C-4, C-7). */
export const WRITE_RULES = `# 執筆規則（必ず守る）
- すべて自分の言葉で書く。出典の文を写さない（言い回しの流用も不可）。
- 原作の文章・台詞・せりふを一切引用しない。場面の再現や描写の言い換えもしない（固有名＝作品名・人名・用語は可）。
- 場面順のあらすじ（シーンごとの再話）にしない。人物・因果・テーマに抽象化し、分析と批評を中心にする。
- 根拠は下に示す要素（ID 付き）だけ。各ブロックの based_on に、そのブロックが拠って立つ要素 ID を必ず1つ以上入れる。示されていない事柄や自分の記憶で補わない。
- 本文はプレーンテキストの日本語。Markdown・HTML・箇条書き記号・絵文字を使わない。1段落はおよそ80〜200字。
- spoiler: そのブロックが明かす内容の最大（none＝前提のみ／mid＝中盤の展開／ending＝結末に関わる）。
- epistemic: 作品内の確定事実だけを述べるなら canon、分析・解釈を含むなら sfsh_analysis。迷ったら sfsh_analysis。`;

const BLOCK_PROPS = {
  heading: { type: ["string", "null"] },
  paragraphs: { type: "array", items: { type: "string" }, minItems: 1 },
  based_on: { type: "array", items: { type: "string" } },
  spoiler: { type: "string", enum: [...SPOILERS] },
  epistemic: { type: "string", enum: ["canon", "sfsh_analysis"] },
} as const;
const BLOCK_REQ = ["heading", "paragraphs", "based_on", "spoiler", "epistemic"];

const QUIZ_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["quiz_id", "question", "answer", "explanation", "based_on", "spoiler"],
  properties: {
    quiz_id: { type: "string" },
    question: { type: "string" },
    answer: { type: "string" },
    explanation: { type: "string" },
    based_on: { type: "array", items: { type: "string" } },
    spoiler: { type: "string", enum: [...SPOILERS] },
  },
} as const;

/** Haiku: all page text in one call. */
export const WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "figure_notes", "intros", "quiz"],
  properties: {
    overview: { type: "array", items: { type: "object", additionalProperties: false, required: BLOCK_REQ, properties: BLOCK_PROPS } },
    figure_notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["figure", ...BLOCK_REQ],
        properties: { figure: { type: "string", enum: ["relations", "reverse_plot", "matrix"] }, ...BLOCK_PROPS },
      },
    },
    intros: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", ...BLOCK_REQ],
        properties: { page: { type: "string", enum: ["themes", "context", "interpretations"] }, ...BLOCK_PROPS },
      },
    },
    quiz: { type: "array", items: QUIZ_ITEM },
  },
} as const;

const UPDATED_UNIT = {
  type: "object",
  additionalProperties: false,
  required: ["id", "heading", "paragraphs", "question", "answer", "explanation", "based_on", "spoiler", "epistemic"],
  properties: {
    id: { type: "string" },
    heading: { type: ["string", "null"] },
    paragraphs: { type: "array", items: { type: "string" } },
    question: { type: ["string", "null"] },
    answer: { type: ["string", "null"] },
    explanation: { type: ["string", "null"] },
    based_on: { type: "array", items: { type: "string" } },
    spoiler: { type: "string", enum: [...SPOILERS] },
    epistemic: { type: "string", enum: ["canon", "sfsh_analysis"] },
  },
} as const;

/** Haiku: revision after Luna's findings. */
export const WRITE_REVISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["responses", "updated", "removed_ids"],
  properties: {
    responses: RESPONSES_SCHEMA,
    updated: { type: "array", items: UPDATED_UNIT },
    removed_ids: { type: "array", items: { type: "string" } },
  },
} as const;

/** Haiku: rewrite of blocks whose sentences matched a saved source verbatim (≥ 30 chars). */
export const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "paragraphs", "question", "answer", "explanation"],
        properties: {
          id: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
          question: { type: ["string", "null"] },
          answer: { type: ["string", "null"] },
          explanation: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export interface WritePromptInput {
  title: string;
  /** Compact JSON of the public projection (public elements only). */
  elements: string;
  figures: { relations: boolean; reverse_plot: boolean; matrix: boolean };
  intros: { themes: boolean; context: boolean; interpretations: boolean };
  quiz: { id: string; quiz_type: string; question: string; answer: string; explanation: string; based_on: string[] }[];
}

export function writePrompt(o: WritePromptInput): string {
  const figs = (Object.keys(o.figures) as (keyof WritePromptInput["figures"])[]).filter((k) => o.figures[k]);
  const intros = (Object.keys(o.intros) as (keyof WritePromptInput["intros"])[]).filter((k) => o.intros[k]);
  return `あなたは物語分析サイトの執筆者です。作品『${o.title}』の作品ページの本文を書いてください。読者は作品の構造と面白さを理解したい人です。

${WRITE_RULES}

# 書くもの
1. overview: 2〜4ブロック。(1) この作品は何か、(2) 人物と因果の水準で何が起きるか（場面順に追わない）、(3) なぜこの作品が効いているのか（構造上の工夫・テーマ）。各ブロックに短い見出し（heading）を付ける。因果は events（caused_by／leads_to）、人物の欲望と変化は motives・arcs、世界の決まりは world_rules を根拠に使い、based_on にその ID を入れてよい。
2. figure_notes: 図ごとに1ブロック（1〜2段落、短く）。この作品でその図をどう読むとよいか（どこに注目するか）。図そのものの説明書ではなく、この作品の読み方を書く。書く図: ${figs.join(", ") || "なし（空配列にする）"}。図の意味: relations＝人物関係図（フェーズで関係が変わる）／reverse_plot＝結末から原因へさかのぼる木／matrix＝誰がどの秘密をいつ知っているか（読者の列を含む）。
3. intros: ページごとに1ブロック（1〜2段落）。ページの導入。書くページ: ${intros.join(", ") || "なし（空配列にする）"}。themes＝テーマ・批評／context＝文化的文脈／interpretations＝解釈の分岐。
4. quiz: 下の各クイズ項目（quiz_id）について、問題・答え・解説を読者向けに整えて書き直す。因果・動機・反実仮想を問う形にし、固有名や数字を当てさせる暗記問題にしない。解説は答えがなぜ導けるかを1〜3文で。新しい quiz_id を作らない。

# 要素（公開対象。ID で参照する）
${o.elements}

# クイズ項目（下書き）
${o.quiz.map((q) => `- ${q.id} [${q.quiz_type}] 問: ${q.question} / 答: ${q.answer} / 解説: ${q.explanation} / 根拠: ${q.based_on.join(", ") || "なし"}`).join("\n") || "（なし。quiz は空配列）"}
`;
}

export interface ReviewUnitView {
  id: string;
  page: string;
  text: string;
  based_on: string[];
  spoiler: string;
  epistemic: string;
}

export const WRITE_REVIEW_RULES = `# レビュー規則
- あなたはレビュー役です。本文を書き換えず、指摘（findings）だけを返してください。
- 本文を、示した要素（NKG）とその裏づけの claim と突き合わせ、次を指摘する:
  unsupported（要素・claim が支持しない記述）／overreach（根拠からの推論が過剰）／contradiction（要素・claim・他のブロックとの矛盾）／
  copied_phrase（出典や原作の言い回し・台詞の写し）／too_concrete（場面の再現・場面順の再話に近い）／misclassified（spoiler・epistemic の区分誤り）／missing（重要な欠落）
- target_id は対象ブロックの ID。evidence は自分の言葉で短く（120字以内）。引用はしない。
- 分析・解釈として書かれ epistemic が sfsh_analysis の記述は、根拠要素から筋が通る限り overreach としない。
- 問題が無ければ findings は空配列。`;

export function writeReviewPrompt(o: { title: string; units: ReviewUnitView[]; elements: string; claims: Claim[]; prior: ReviewRound[]; round: number; maxRounds: number }): string {
  return `作品『${o.title}』の作品ページ本文（Haiku 執筆）をレビューしてください。

${WRITE_REVIEW_RULES}

# 本文ブロック
${o.units.map((u) => `## ${u.id}（${u.page}; spoiler=${u.spoiler}; epistemic=${u.epistemic}; based_on=${u.based_on.join(",") || "なし"}）\n${u.text}`).join("\n\n")}

# 要素（NKG の公開対象）
${o.elements}

# 要素の裏づけ claim（内部資料）
${formatClaims(o.claims)}
${priorRoundsBlock(o.prior, o.round, o.maxRounds)}`;
}

export function writeRevisePrompt(o: { title: string; units: ReviewUnitView[]; findings: Finding[]; elements: string; round: number; maxRounds: number }): string {
  return `作品『${o.title}』の作品ページ本文にレビューの指摘が付きました。各指摘に revised（直した）か declined（直さない。理由）で答えてください。

- 直したブロックは updated に全項目を入れる（文章ブロックは paragraphs と heading、question/answer/explanation は null。クイズは question/answer/explanation を入れ、paragraphs は空配列、heading は null）。
- 根拠の無い記述は削るか、根拠要素から言える範囲に弱める。ブロックごと不要なら removed_ids に ID を入れる。
- 新しいブロック ID を作らない。

${WRITE_RULES}

# 現在の本文ブロック
${o.units.map((u) => `## ${u.id}（${u.page}; spoiler=${u.spoiler}; epistemic=${u.epistemic}; based_on=${u.based_on.join(",") || "なし"}）\n${u.text}`).join("\n\n")}

# 指摘
${o.findings.map((f) => `- ${f.finding_id} [${f.type}] ${f.target_id}: ${f.evidence}`).join("\n")}

# 要素（公開対象）
${o.elements}
${lastRoundNote(o.round, o.maxRounds)}`;
}

export function rewritePrompt(o: { title: string; units: { id: string; text: string; flagged: string[]; isQuiz: boolean }[] }): string {
  return `作品『${o.title}』の作品ページ本文のうち、下の文が出典の文と長く一致していました（30字以上の連続一致）。該当ブロックを、意味を保ったまま自分の言葉で書き直してください。

- 一致した文は語順・語彙を変えて完全に言い換える。出典の言い回しを残さない。原作の台詞や文章も引用しない。
- 書き直したブロックごとに units に入れる。文章ブロックは paragraphs に全段落を入れ、question/answer/explanation は null。クイズは question/answer/explanation を入れ、paragraphs は空配列。
- 内容を増やさない。根拠の無いことを足さない。

${WRITE_RULES}

# 書き直すブロック
${o.units.map((u) => `## ${u.id}${u.isQuiz ? "（クイズ）" : ""}\n${u.text}\n一致した文:\n${u.flagged.map((s) => `- ${s}`).join("\n")}`).join("\n\n")}
`;
}

export { FINDING_TYPES };
