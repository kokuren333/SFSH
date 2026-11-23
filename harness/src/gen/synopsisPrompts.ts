/**
 * AMENDMENT 11 (BRIEF §14, 2026-11-23 12:51): prompts and schemas for the long spoiler synopsis
 * 「あらすじ（全編・ネタバレ）」 on the work page. Haiku writes (plan → chapters in parallel), Luna reviews
 * (findings only, strict schema shared with the page review), Haiku revises.
 *
 * The synopsis is the one page that IS a chronological retelling (the page rules in prompts.ts forbid that for every
 * other page), so it carries its own rule block. C-2 is unchanged: no quotation of the original text or dialogue,
 * no scene reproduction — a summary retold in our own words. Interpretation / evaluation is not mixed in (fact
 * layer prose); the analysis lives on the essay pages.
 */
import type { Claim } from "../research/claimTypes.ts";
import { formatClaims } from "../nkg/prompts/common.ts";
import { lastRoundNote, priorRoundsBlock, type Finding, type ReviewRound } from "../nkg/review.ts";
import type { ReviewUnitView } from "./prompts.ts";

/** Targets (characters = code points). Measured and recorded as advisory only — never truncated (AMENDMENT 06). */
export const SYNOPSIS_SPEC = {
  /** Overall range by the scale of the work (BRIEF: 8,000–15,000, longer works thicker). See synopsisTarget(). */
  totalRange: [8000, 15000],
  introChars: [300, 400],
  chapters: [5, 12],
  chapterChars: [600, 1400],
  /** Sections (subheadings) per chapter. */
  sectionsPerChapter: [1, 3],
  /** Writing spec v2 paragraph rule applies to the synopsis too. */
  paragraphChars: [80, 250],
  paragraphMax: 300,
  heading: 20,
} as const;
/** Max chapters / sections kept (tolerant above the target; the excess is recorded, not dropped). */
export const MAX_SYNOPSIS_CHAPTERS = 16;
export const MAX_SYNOPSIS_SECTIONS = 4;

/** Words that signal interpretation / evaluation mixed into the fact-layer synopsis (counted, advisory). */
export const SYNOPSIS_INTERPRETIVE_PATTERNS = ["象徴", "と読める", "と読めます", "と考えられ", "かもしれ", "暗示", "示唆", "見事", "秀逸", "テーマ", "メタファー", "隠喩"] as const;

const span = (x: readonly [number, number]) => `${x[0]}〜${x[1]}`;

export const SYNOPSIS_RULES = `# あらすじの執筆規則（必ず守る）
- すべて自分の言葉で書く。出典の文を写さない（言い回しの流用も不可）。
- 原作の文章・台詞・せりふを一切引用しない。会話を再現しない。人物の発言は「〜を打ち明ける」「〜を求める」のように行為として要約し、台詞を地の文に言い換えて並べることもしない。鉤括弧（「」『』）は作品名と作品内の固有の用語にだけ使う。
- 場面の描写を再現しない（情景・動作・表情を逐一なぞらない）。出来事の経緯・仕組み・動機・結果を説明する要約として語り直す。
- 冒頭から結末まで、物語の中で起きる順（events の story_order と phases の順）に語る。結末まで明かしてよい（全編ネタバレのページ）。
- 素材は下に示す要素（ID 付き）と調査メモ（claim）だけ。そこに無い細部（台詞・外見・情景・日付・場所の名前・心情の細部・出来事）を自分の記憶や想像で補わない。分量は、素材にある因果（caused_by／leads_to）・人物の狙い（motives）・変化（arcs）・世界の仕組み（world_rules）・関係の変化（relations）・伏線と回収（setups）・感情の動き（emotion_beats）・調査メモの事実を丁寧に説明することで出す。同じ内容の言い換え・一般論・評価で水増ししない。
- 解釈・考察・評価・テーマ論を混ぜない（それは別の解釈ページが担う）。「〜を象徴する」「〜と読める」「見事な」「テーマ」のような解釈・評価の言葉を使わない。人物の動機や心情は、motives・arcs・emotion_beats・claim に示された範囲で、事実として簡潔に述べる。
- 人物は一覧にしない。その人物が初めて出てくる場面で、名前・立場・他の人物との関係を文の中で紹介する。2回目以降は名前で呼ぶ。
- based_on: 各ブロックが拠って立つ要素 ID（events・characters・relations・motives・arcs・world_rules・setups・emotion_beats・secrets・outcomes の id）を必ず1つ以上入れる。語った出来事・人物の ID はすべて入れる。claim の ID（c0001 など）は based_on に入れない。
- 本文はプレーンテキストの日本語。Markdown・HTML・箇条書き記号・絵文字を使わない。読者への呼びかけはしない。
- 文体は全文「です・ます調」で統一する（文末は「〜ます」「〜ました」「〜です」「〜でした」など）。素材や調査メモが「だ・である調」で書かれていても、本文は必ずです・ます調にする。
- 1段落は2〜5文、目安 全角${span(SYNOPSIS_SPEC.paragraphChars)}字。${SYNOPSIS_SPEC.paragraphMax}字を超えそうな段落は二つに分ける（スマートフォンで読むため）。一文だけの段落を続けない。
- 小見出し（heading）は全角${SYNOPSIS_SPEC.heading}字以内で、その節で起きることが分かる言葉にする（ネタバレしてよい）。
- spoiler: そのブロックが明かす内容の最大（none／mid／ending）。epistemic: 作品内の確定事実だけなら canon（あらすじは原則 canon）。`;

const SPOILERS = ["none", "mid", "ending"] as const;

/** Haiku: chapter plan + intro (one call). */
export const SYNOPSIS_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intro", "chapters"],
  properties: {
    intro: {
      type: "object",
      additionalProperties: false,
      required: ["paragraphs", "based_on"],
      properties: { paragraphs: { type: "array", items: { type: "string" }, minItems: 1 }, based_on: { type: "array", items: { type: "string" } } },
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "phase_ids", "event_ids", "claim_ids", "introduces", "gist", "target_chars"],
        properties: {
          heading: { type: "string" },
          phase_ids: { type: "array", items: { type: "string" } },
          event_ids: { type: "array", items: { type: "string" } },
          claim_ids: { type: "array", items: { type: "string" } },
          introduces: { type: "array", items: { type: "string" } },
          gist: { type: "string" },
          target_chars: { type: "number" },
        },
      },
    },
  },
} as const;

/** Haiku: one chapter body (sections = subheading + paragraphs). */
export const SYNOPSIS_CHAPTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "paragraphs", "based_on", "spoiler", "epistemic"],
        properties: {
          heading: { type: ["string", "null"] },
          paragraphs: { type: "array", items: { type: "string" }, minItems: 1 },
          based_on: { type: "array", items: { type: "string" } },
          spoiler: { type: "string", enum: [...SPOILERS] },
          epistemic: { type: "string", enum: ["canon", "sfsh_analysis"] },
        },
      },
    },
  },
} as const;

export interface SynopsisPlanChapter {
  heading: string;
  phase_ids: string[];
  event_ids: string[];
  claim_ids: string[];
  introduces: string[];
  gist: string;
  target_chars: number;
}

export function synopsisPlanPrompt(o: { title: string; material: string; target: readonly [number, number] }): string {
  return `あなたは物語の要約サイトの執筆者です。作品『${o.title}』の「あらすじ（全編・ネタバレ）」を書く前に、章立ての計画と導入文を作ってください。このページを読めば、作品を見ていない人にも物語の始まりから結末までの流れが分かるようにします。

${SYNOPSIS_RULES}

# このリクエストで作るもの
1. intro（導入）: 全角${span(SYNOPSIS_SPEC.introChars)}字、1〜2段落。物語の出発点（舞台・主人公の立場・物語を動かす発端）と、物語全体がどんな出来事の連なりなのかを、結末は伏せずに簡潔に示す。評価や見どころの宣伝はしない。based_on に要素 ID。
2. chapters（章立て）: ${span(SYNOPSIS_SPEC.chapters)}章。冒頭から結末までを、物語の区切り（phases・話数・アークの切れ目）に沿って時系列に分ける。素材の多い区切りは2〜3章に分け、素材の少ない区切りは隣と合わせてよい。最後の章は結末（その後を含む）にする。各章について:
   - heading: 章の見出し（全角${SYNOPSIS_SPEC.heading}字以内。「第N章」は付けない。番号はコードが振る）。
   - phase_ids: その章が扱う phase の id。
   - event_ids: その章で語る出来事の id（物語の順。どの出来事もどこかの章に一度だけ入れる）。
   - claim_ids: その章で使う調査メモ（claim）の id。
   - introduces: その章で初めて登場し、紹介する人物の名前（各人物は一度だけ）。
   - gist: その章で起きることの要点（全角120字以内。執筆担当への指示として、出来事の順と因果を書く）。
   - target_chars: その章の目標字数（全角${span(SYNOPSIS_SPEC.chapterChars)}の範囲で、素材の量に応じて配分）。
   章の目標字数の合計は、素材が足りる範囲で 全角${span(o.target)}字を目安にする。素材が足りないのに目標を大きくしない（水増しの原因になる）。

# 素材（要素は ID で参照する。claims は調査メモで、ID は based_on に入れない）
${o.material}
`;
}

export function synopsisChapterPrompt(o: {
  title: string;
  material: string;
  intro: string;
  plan: SynopsisPlanChapter[];
  index: number;
  introducedBefore: string[];
  /** JSON of this chapter's own material (assigned events + linked elements + assigned claims). */
  focus?: string;
}): string {
  const ch = o.plan[o.index]!;
  const elsewhere = o.plan.flatMap((c, i) => (i === o.index ? [] : c.event_ids)).filter((id) => !ch.event_ids.includes(id));
  const outline = o.plan.map((c, i) => `${i + 1}. ${c.heading} — ${c.gist}`).join("\n");
  return `あなたは物語の要約サイトの執筆者です。作品『${o.title}』の「あらすじ（全編・ネタバレ）」のうち、第${o.index + 1}章「${ch.heading}」の本文だけを書いてください。章は並行して別々に書かれ、あとで順に連結されます。前後の章と内容が重ならないよう、この章の範囲だけを語ってください。

${SYNOPSIS_RULES}

# この章の書き方
- 目標は全角 約${Math.round(ch.target_chars)}字（その8割以上を目安にする。ただし素材にない事柄を足して届かせることはしない）。${span(SYNOPSIS_SPEC.sectionsPerChapter)}節（ブロック）に分け、各節に小見出し（heading）を付け、各節は2〜5段落。
- この章で語る出来事（物語の順）: ${ch.event_ids.join(", ") || "（指定なし。gist に従う）"}。出来事ごとに、素材にある範囲で (1) その時点の状況と前提、(2) 誰が何を望み・恐れて動いたか、(3) 何が起きたか、(4) その結果と次の出来事へのつながり、を順に説明する。
- 下の「この章の素材」に挙げた項目（出来事・動機・変化・ルール・関係・伏線・感情・調査メモ）は、この章の本文にすべて織り込む。全体の素材のうち、この章の範囲に入るものも使ってよい。
- この章の要点: ${ch.gist}
- この章で初めて紹介する人物: ${ch.introduces.join("、") || "なし"}（名前・立場・関係を文中で紹介する）。
- すでに前の章で紹介済みの人物: ${o.introducedBefore.join("、") || "なし"}（名前だけで呼び、立場や経歴を説明し直さない）。
- 他の章が語る出来事（${elsewhere.join(", ") || "なし"}）は、この章では詳しく語らない（前後のつながりとして一文で触れる程度）。章の最初で前の章の内容を繰り返さず、章の終わりで次の章の内容を先取りしない。

# この章の素材
${o.focus ?? "（全体の素材から、この章の出来事に関わるものを使う）"}

# 全体の章立て（参照用）
${outline}

# 導入文（参照用。繰り返さない）
${o.intro}

# 素材（要素は ID で参照する。claims は調査メモで、ID は based_on に入れない）
${o.material}
`;
}

export const SYNOPSIS_REVIEW_RULES = `# レビュー規則（あらすじ）
- あなたはレビュー役です。本文を書き換えず、指摘（findings）だけを返してください。
- このページは冒頭から結末までの時系列の語り直し（要約）であることが仕様です。時系列に出来事を語っていること自体は too_concrete にしない。
- 本文を、示した素材（NKG の要素）と調査メモ（claim）に突き合わせ、次を指摘する:
  unsupported（素材にない出来事・細部・台詞・人物の心情）／overreach（素材からの推測を確定した事実として書いている）／
  contradiction（時系列・因果・人物関係が素材や他のブロックと矛盾する。章の順序の前後関係の誤りを含む）／
  copied_phrase（出典や原作の言い回し・台詞の写し。台詞を地の文に言い換えて並べたものを含む）／
  too_concrete（場面描写の再現や会話の再現。要約ではなく場面をなぞっている）／
  misclassified（解釈・考察・評価・テーマ論が混ざっている。あらすじは事実層の散文であるべき。spoiler・epistemic の区分誤りも含む）／
  missing（主要な出来事・転換・結末が抜けている、人物が紹介なしに出てくる）
- target_id は対象ブロックの ID。evidence は自分の言葉で短く（120字以内）。引用はしない。
- 問題が無ければ findings は空配列。`;

const unitsBlock = (units: ReviewUnitView[]) =>
  units.map((u) => `## ${u.id}（${u.page}; spoiler=${u.spoiler}; epistemic=${u.epistemic}; based_on=${u.based_on.join(",") || "なし"}）\n${u.text}`).join("\n\n");

export function synopsisReviewPrompt(o: { title: string; units: ReviewUnitView[]; material: string; claims: Claim[]; prior: ReviewRound[]; round: number; maxRounds: number }): string {
  return `作品『${o.title}』の「あらすじ（全編・ネタバレ）」（Haiku 執筆）をレビューしてください。ブロックは読む順に並んでいます（syn_intro が導入、syn_cNN_sMM が第NN章の第MM節）。

${SYNOPSIS_REVIEW_RULES}

# 本文ブロック
${unitsBlock(o.units)}

# 素材（NKG の公開要素。解釈の層は除いてある）
${o.material}

# 要素の裏づけ claim（内部資料）
${formatClaims(o.claims)}
${priorRoundsBlock(o.prior, o.round, o.maxRounds)}`;
}

export function synopsisRevisePrompt(o: { title: string; units: ReviewUnitView[]; findings: Finding[]; material: string; round: number; maxRounds: number }): string {
  return `作品『${o.title}』の「あらすじ（全編・ネタバレ）」にレビューの指摘が付きました。各指摘に revised（直した）か declined（直さない。理由）で答えてください。

- 直したブロックは updated に全項目を入れる（paragraphs と heading を入れ、question/answer/explanation は null）。
- 指摘された箇所だけを直し、指摘の無い段落は書き換えない。段落は目安 全角${span(SYNOPSIS_SPEC.paragraphChars)}字、${SYNOPSIS_SPEC.paragraphMax}字を超えるなら分ける。
- 根拠の無い記述は削るか、素材から言える範囲に弱める。解釈・評価が混ざっていると指摘されたら、その文を削るか事実の記述に改める。ブロックごと不要なら removed_ids に ID を入れる（導入 syn_intro は消さない）。
- 新しいブロック ID を作らない。

${SYNOPSIS_RULES}

# 現在の本文ブロック
${unitsBlock(o.units)}

# 指摘
${o.findings.map((f) => `- ${f.finding_id} [${f.type}] ${f.target_id}: ${f.evidence}`).join("\n")}

# 素材
${o.material}
${lastRoundNote(o.round, o.maxRounds)}`;
}

export function synopsisRewritePrompt(o: { title: string; units: { id: string; text: string; flagged: string[] }[] }): string {
  return `作品『${o.title}』の「あらすじ（全編・ネタバレ）」のうち、下の文が出典の文と長く一致していました（30字以上の連続一致）。該当ブロックを、意味を保ったまま自分の言葉で書き直してください。

- 一致した文は語順・語彙を変えて完全に言い換える。出典の言い回しを残さない。原作の台詞や文章も引用しない。
- 書き直したブロックごとに units に入れる。paragraphs に全段落を入れ、question/answer/explanation は null。
- 内容を増やさない。根拠の無いことを足さない。段落の数と長さを保つ。

${SYNOPSIS_RULES}

# 書き直すブロック
${o.units.map((u) => `## ${u.id}\n${u.text}\n一致した文:\n${u.flagged.map((s) => `- ${s}`).join("\n")}`).join("\n\n")}
`;
}

/** Haiku: style-only conversion to です・ます (blocks whose sentences are mostly plain style). */
export function synopsisStylePrompt(o: { title: string; units: { id: string; text: string }[] }): string {
  return `作品『${o.title}』の「あらすじ（全編・ネタバレ）」のうち、下のブロックは文体が「だ・である調」になっています。サイト全体の文体に合わせ、文末を「です・ます調」（〜ます／〜ました／〜です／〜でした）に直してください。

- 文末の形だけを直す。内容・語順・段落の数と区切りは変えない。情報を足したり削ったりしない。
- 小見出しは変えない（paragraphs だけを返す）。
- units に、直したブロックごとに id と paragraphs（全段落）を入れる。question/answer/explanation は null。

# 直すブロック
${o.units.map((u) => `## ${u.id}\n${u.text}`).join("\n\n")}
`;
}
