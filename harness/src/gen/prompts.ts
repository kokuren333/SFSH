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
/**
 * Writing spec v2 (AMENDMENT 10-3, BRIEF §14; REQUIREMENTS §3.2 S3 / §6.4). The AMENDMENT 09 card limits
 * (paragraph ≤ 120, block ≤ 300) cut the text into database-like fragments; v2 writes the body pages as
 * continuous prose with a point of view. Cards and chips stay for entrances and navigation only (site side).
 * Every TextBlock is one section = optional subheading + several ordinary paragraphs. Counted in characters
 * (code points). Targets only: write.ts records the measured volume in write_report.json (`prose_spec`) and
 * never drops or truncates text (AMENDMENT 06).
 */
export const PROSE_SPEC = {
  /** Core essay pages (themes / context / interpretations): sections per page and characters per page. */
  essaySections: [3, 5],
  essayChars: [1200, 2500],
  /** Work-page overview: sections and characters in total. */
  overviewSections: [3, 4],
  overviewChars: [800, 1500],
  /** Figure reading note per figure page. */
  figureNoteChars: [400, 900],
  /** Paragraph: ordinary length; above `paragraphMax` it is split for phone reading. */
  paragraphChars: [80, 250],
  paragraphMax: 300,
  /** Subheading length. */
  heading: 20,
  /** Mechanical hedges (「〜と読める」 etc.): at most this many per page. */
  hedgesPerPage: 2,
  quizQuestion: 80,
  quizAnswer: 100,
  quizExplanation: 220,
} as const;
/** Max sections kept per page (tolerant above the target; the excess is recorded, not dropped). */
export const MAX_ESSAY_SECTIONS = 6;
export const MAX_OVERVIEW_SECTIONS = 5;
/** Hedge expressions counted by the prose check (AMENDMENT 10-3: avoid repeating them mechanically). */
export const HEDGE_PATTERNS = ["と読める", "と読めます", "と考えられ", "かもしれ", "ように見え", "と言える", "といえる", "と言えます", "といえます", "と解釈でき"] as const;

/** Rules carried by every S3 writing / revision / rewrite prompt (C-2, C-3, C-4, C-7, writing spec v2). */
export const WRITE_RULES = `# 執筆規則（必ず守る）
- すべて自分の言葉で書く。出典の文を写さない（言い回しの流用も不可）。
- 原作の文章・台詞・せりふを一切引用しない。場面の再現や描写の言い換えもしない（固有名＝作品名・人名・用語は可）。
- 場面順のあらすじ（シーンごとの再話）にしない。人物・因果・テーマに抽象化し、分析と批評を中心にする。
- 根拠は下に示す要素（ID 付き）だけ。各ブロックの based_on に、そのブロックが拠って立つ要素 ID を必ず1つ以上入れる（論じた要素はすべて入れる）。示されていない事柄や自分の記憶で補わない。
- 本文はプレーンテキストの日本語。Markdown・HTML・箇条書き記号・絵文字を使わない。
- spoiler: そのブロックが明かす内容の最大（none＝前提のみ／mid＝中盤の展開／ending＝結末に関わる）。
- epistemic: 作品内の確定事実だけを述べるなら canon、分析・解釈を含むなら sfsh_analysis。迷ったら sfsh_analysis。

# 書き方（執筆仕様 v2：読み物としての散文）
- 本文は連続した散文で書く。1ブロックは「小見出し（heading）＋数段落（paragraphs）」の一節として、そのまま続けて表示される。カードの見出しや要約の一文ではない。
- 1段落は2〜5文、目安${PROSE_SPEC.paragraphChars[0]}〜${PROSE_SPEC.paragraphChars[1]}字。スマートフォンで読みやすいよう、${PROSE_SPEC.paragraphMax}字を超えそうな段落は二つに分ける。一文だけの段落や、短文を並べただけの段落にしない。
- 段落と段落、節と節を論理でつなぐ。前の段落の結論を受けて次の問いへ進む流れにし、要素を一つずつ言い換えて並べるだけの書き方をしない。
- 視点を持って書く。何がこの作品を面白くしているのか、なぜそう組み立てられているのか、どこに強さと弱さがあるのかを、根拠要素に基づいて論じる。
- 機械的なヘッジを繰り返さない。「〜と読める」「〜と考えられる」「〜かもしれない」「〜といえる」のような言い回しは1ページに${PROSE_SPEC.hedgesPerPage}回までにし、表現に変化をつける。分析の文は epistemic=sfsh_analysis で区分されるので、根拠から筋が通る範囲では言い切ってよい。
- 事実と解釈を文の上でも分ける。作品内で確定している事柄（canon の要素）は事実として述べ、そこから先の読みは、解釈であることが文脈からわかる形で書く（例: 「ここから見えてくるのは」「この配置が示しているのは」）。一般的な評価やファンの考察を、要素に無いのに持ち出さない。
- 小見出し（heading）は全角${PROSE_SPEC.heading}字以内。その節の論点が伝わる言葉にする。
- 専門用語は避けるか、短く言い換える。
- です・ます調で書く。読者に話しかける言い回し（呼びかけや「〜してみましょう」など）は使わない。`;

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
  /** Core essay pages to write (schema key `intros` kept for compatibility: in v2 these are the page bodies). */
  intros: { themes: boolean; context: boolean; interpretations: boolean };
  /** Whether the work has interpretation items (otherwise the interpretations essay works from structural ambiguity). */
  hasInterpretationItems?: boolean;
  /**
   * Which part this call writes (the S3 write runs one call per part in parallel to keep each call short):
   * "frame" = overview + figure_notes + quiz; a page name = that essay page only. Absent = everything.
   */
  part?: WritePart;
  quiz: { id: string; quiz_type: string; question: string; answer: string; explanation: string; based_on: string[] }[];
}

const span = (x: readonly [number, number]) => `${x[0]}〜${x[1]}`;
export type WritePart = "frame" | "themes" | "context" | "interpretations";

export function writePrompt(o: WritePromptInput): string {
  const figs = (Object.keys(o.figures) as (keyof WritePromptInput["figures"])[]).filter((k) => o.figures[k]);
  const intros = (Object.keys(o.intros) as (keyof WritePromptInput["intros"])[]).filter((k) => o.intros[k]);
  const interp =
    o.hasInterpretationItems === false
      ? "この作品には解釈の分岐（interpretations）の要素がない。その場合は、人物の動機・変容・因果・結末の要素のうち、作品が答えを一つに決めていない点（analysis に表れている曖昧さ）を取り上げ、複数の読みが成り立つ理由を独自分析として論じる。批評家やファンがそう言っている、とは書かない。"
      : "interpretations の各論点について、それぞれの読みを支える要素と、読みを分ける作品側の仕掛けを論じる。どの読みが優勢かを断定せず、読みの違いが作品の見え方をどう変えるかを書く。";
  const want = (k: "overview" | "figure_notes" | "intros" | "quiz") =>
    !o.part || (o.part === "frame" ? k !== "intros" : k === "intros");
  const pages = o.part && o.part !== "frame" ? intros.filter((k) => k === o.part) : intros;
  const items: string[] = [];
  const skip = (["overview", "figure_notes", "intros", "quiz"] as const).filter((k) => !want(k));
  if (want("overview")) items.push(`overview（作品ページの概要）: ${span(PROSE_SPEC.overviewSections)}節（ブロック）、合計 全角${span(PROSE_SPEC.overviewChars)}字。各節は小見出し＋2〜4段落。次の役割を順に担う。
   (1) この作品は何か、どこに引力があるか
   (2) 人物と因果の水準で何が起きるか（場面順に追わず、欲望・選択・帰結の構造として）
   (3) なぜこの作品が効いているのか（構造上の工夫・テーマ）
   (4) 必要なら、受け止められ方や文脈がこの作品の見え方をどう変えるか
   因果は events（caused_by／leads_to）、人物の欲望と変化は motives・arcs、世界の決まりは world_rules を根拠に使い、based_on にその ID を入れる。`);
  if (want("figure_notes")) items.push(`figure_notes（図のページの本文）: 図ごとに1ブロック、全角${span(PROSE_SPEC.figureNoteChars)}字、2〜4段落。小見出しを付ける。図の操作説明ではなく、この作品でその図が何を明らかにするか（どこに注目すると構造が見えるか、図が示す緊張や転換は何か）を論じる。書く図: ${figs.join(", ") || "なし（空配列にする）"}。図の意味: relations＝人物関係図（フェーズで関係が変わる）／reverse_plot＝結末から原因へさかのぼる木／matrix＝誰がどの秘密をいつ知っているか（読者の列を含む）。`);
  if (want("intros")) {
    const desc: Record<string, string> = {
      themes: "themes（テーマ・批評）: 作品が投げかける中心の問い、その問いが人物の動機・変容・出来事を通してどう劇として形になるか、価値観の対立、作品の強さと限界（批評）。themes の要素が無い場合は、motives・arcs・events・emotion_beats から作品の問いを組み立てる（独自分析として書く）。",
      context: "context（文化的文脈）: なぜ有名なのか、どう受け止められてきたか、ジャンルの約束事との関係、象徴的な場面がなぜ記憶されるのか（場面を再現せず、効き方を説明する）。根拠は context と iconic の要素だけにし、要素に無い受賞歴・売上・評判を足さない。",
      interpretations: `interpretations（解釈の分岐）: ${interp}`,
    };
    items.push(`intros（核心ページの本文。v2 ではページの導入ではなく本文そのもの）: ページごとに${span(PROSE_SPEC.essaySections)}節（ブロック）、1ページ合計 全角${span(PROSE_SPEC.essayChars)}字。各節は小見出し＋2〜4段落。同じページの節は page に同じ値を入れ、読む順に並べる。書くページ: ${pages.join(", ") || "なし（空配列にする）"}。
${pages.map((k) => `   - ${desc[k]}`).join("\n")}`);
  }
  if (want("quiz")) items.push(`quiz: 下の各クイズ項目（quiz_id）について、問題・答え・解説を読者向けに整えて書き直す。因果・動機・反実仮想を問う形にし、固有名や数字を当てさせる暗記問題にしない。問題は全角${PROSE_SPEC.quizQuestion}字以内。答えは1〜2文で全角${PROSE_SPEC.quizAnswer}字以内。解説は答えがなぜ導けるかを2〜3文で（全角${PROSE_SPEC.quizExplanation}字以内）。新しい quiz_id を作らない。`);
  const quizList = want("quiz")
    ? `

# クイズ項目（下書き）
${o.quiz.map((q) => `- ${q.id} [${q.quiz_type}] 問: ${q.question} / 答: ${q.answer} / 解説: ${q.explanation} / 根拠: ${q.based_on.join(", ") || "なし"}`).join("\n") || "（なし。quiz は空配列）"}`
    : "";
  return `あなたは物語分析サイトの執筆者です。作品『${o.title}』のページ本文を、読み応えのある読み物として書いてください。読者は作品の構造と面白さを深く理解したい人です。

${WRITE_RULES}

# 書くもの
${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}${skip.length ? `\n（このリクエストでは上の項目だけを書く。${skip.join("・")} は空配列にする。）` : ""}

# 要素（公開対象。ID で参照する）
${o.elements}${quizList}
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
- 直すときも散文の形を保つ（小見出し＋通常の長さの段落。段落は目安 全角${PROSE_SPEC.paragraphChars[0]}〜${PROSE_SPEC.paragraphChars[1]}字、${PROSE_SPEC.paragraphMax}字を超えるなら分ける）。指摘された箇所だけを直し、指摘の無い段落は書き換えない。クイズは問題 全角${PROSE_SPEC.quizQuestion}字以内・答え${PROSE_SPEC.quizAnswer}字以内・解説2〜3文${PROSE_SPEC.quizExplanation}字以内。
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
- 段落の数と長さを保つ（散文のまま。要約して短くしない）。

${WRITE_RULES}

# 書き直すブロック
${o.units.map((u) => `## ${u.id}${u.isQuiz ? "（クイズ）" : ""}\n${u.text}\n一致した文:\n${u.flagged.map((s) => `- ${s}`).join("\n")}`).join("\n\n")}
`;
}

export { FINDING_TYPES };
