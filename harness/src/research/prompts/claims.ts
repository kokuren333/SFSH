import { CLAIM_ASPECTS } from "../claimTypes.ts";
import { ASPECT_GUIDE, OWN_WORDS_RULE } from "./common.ts";

export const MAX_CLAIMS_PER_SOURCE = 25;
/** AMENDMENT 12: per-source cap for plot-frame sources (episode / chapter guides carry many events). [暫定] */
export const MAX_CLAIMS_PER_PLOT_SOURCE = 45;
export const CLAIM_TEXT_TARGET = 160;
export const EVIDENCE_QUOTE_MAX = 80;

/** OpenAI-strict schema for s1.claims. */
export const CLAIMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_id", "text", "evidence_quote", "aspects", "epistemic", "phase_hint", "spoiler", "entities", "story_unit", "characters"],
        properties: {
          source_id: { type: "string" },
          text: { type: "string" },
          evidence_quote: { type: "string" },
          aspects: { type: "array", items: { type: "string", enum: [...CLAIM_ASPECTS] } },
          epistemic: { type: "string", enum: ["canon", "consensus", "fan_theory"] },
          phase_hint: { type: "string", enum: ["early", "middle", "end", "whole", "unknown"] },
          spoiler: { type: "string", enum: ["none", "mid", "ending"] },
          entities: { type: "array", items: { type: "string" } },
          story_unit: { type: ["integer", "null"] },
          characters: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface ClaimSourceInput {
  source_id: string;
  title: string;
  tier: string;
  domain: string;
  text: string;
}

export interface ClaimsPromptOptions {
  /**
   * AMENDMENT 12 plot frame: the sources are synopsis / episode-guide pages; extract the story as a chain of
   * event-level facts (one event per claim, story order, episode / chapter number).
   */
  plot?: boolean;
  /** AMENDMENT 12 targeted follow-up: what this extraction should look for first (coverage shortfalls). */
  focus?: string[];
  /** AMENDMENT 16: scope instruction from the job range (null = whole work). Out-of-range facts are not extracted. */
  scope?: string | null;
}

export function buildClaimsPrompt(workTitle: string, sources: ClaimSourceInput[], o: ClaimsPromptOptions = {}): string {
  const lines: string[] = [];
  lines.push(`あなたは物語作品『${workTitle}』の調査担当です。下の出典本文から、作品についての主張（claim）を取り出してください。`);
  lines.push("");
  if (o.scope) {
    lines.push("## 対象範囲（厳守）");
    lines.push(o.scope);
    lines.push("- 範囲外の出来事・設定・人物変化・結末は、出典に書かれていても claim にしない。");
    lines.push("");
  }
  if (o.plot) {
    lines.push("## この出典は「粗筋枠」です（あらすじ・各話/各章ガイド・作品データベース）");
    lines.push("- 物語の出来事を、作中の時系列に沿って、1件に1つの出来事として取り出す。誰が・何をして・その結果どうなったか（次の出来事へのつながり）が分かるように書く。");
    lines.push("- 序盤から結末まで、出典に書かれている範囲を漏れなく覆う。結末・最終回・最後の章の出来事も省かない（spoiler は ending にする）。");
    lines.push("- 出来事の claim には aspects に plot を必ず入れる（因果なら M03、結末なら M02、人物の変化なら M07 も併せてよい）。");
    lines.push("- 出典の文の順序や言い回しをなぞらない。出来事の要点だけを自分の言葉で短くまとめ直す（場面の描写・台詞は書かない）。");
    lines.push(`- 1出典あたり最大 ${MAX_CLAIMS_PER_PLOT_SOURCE} 件程度。`);
    lines.push("");
  }
  if (o.focus && o.focus.length) {
    lines.push("## 今回は特に次の不足を埋める事実を優先して取り出す（出典に書かれている範囲で）");
    for (const f of o.focus) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push(`## 最重要: ${OWN_WORDS_RULE}。`);
  lines.push(`- text は日本語で、自分の言葉で書く（${CLAIM_TEXT_TARGET}字以内）。1つの claim には1つの事実・関係・因果だけを書く。`);
  lines.push("- 出典の文や言い回しを写さない。台詞・歌詞・場面描写を再現しない。固有名（人物名・用語・作品名）は使ってよい。");
  lines.push("- 出典に書かれていないことを推測で足さない。");
  lines.push("");
  lines.push("## 各項目");
  lines.push("- source_id: その claim の根拠になった出典の id（下の <source id=...> の値だけ）。");
  lines.push(`- evidence_quote: 根拠の確認用に、その出典本文から一字一句そのまま抜き出した短い文字列（${EVIDENCE_QUOTE_MAX}字以内）。照合にだけ使い、公開しない。text にこれを流用しない。`);
  lines.push("- aspects: 下の観点 ID（複数可）。");
  lines.push("- epistemic: canon = 作品内で確定した事実・公式情報 / consensus = 批評・受容で広く一致した見方 / fan_theory = ファンの考察・解釈。");
  lines.push("- phase_hint: 物語のどの辺りの話か（early / middle / end / whole / unknown）。");
  lines.push("- spoiler: none = ネタバレなし / mid = 中盤の展開 / ending = 結末に関わる。");
  lines.push("- entities: 登場する固有名（人物・組織・場所・用語）。");
  lines.push("- story_unit: その出来事が属する話数・章番号（例: 第3話 → 3）。出典に明記されているときだけ入れ、分からなければ null。");
  lines.push("- characters: その claim に関わる登場人物の名前だけ（組織・場所・用語は入れない。出典にある正式な名前で）。人物が関わらなければ空配列。");
  if (!o.plot) lines.push(`- 1出典あたり最大 ${MAX_CLAIMS_PER_SOURCE} 件程度。物語の理解に効く事実・関係・因果・受容を優先する。`);
  lines.push("");
  lines.push("観点 ID:");
  lines.push(ASPECT_GUIDE);
  lines.push("");
  lines.push("## 出典本文（抽出テキスト。途中で切れていることがある）");
  for (const s of sources) {
    lines.push(`<source id="${s.source_id}" tier="${s.tier}" domain="${s.domain}" title="${s.title.replace(/"/g, "'")}">`);
    lines.push(s.text);
    lines.push("</source>");
  }
  return lines.join("\n");
}

/** OpenAI-strict schema for s1.claims.rephrase (optional one-shot rewording before a copied_phrase drop). */
export const REPHRASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "text"],
        properties: { key: { type: "string" }, text: { type: "string" } },
      },
    },
  },
} as const;

export function buildRephrasePrompt(items: { key: string; text: string }[]): string {
  const lines: string[] = [];
  lines.push("次の各文は、出典の文と長く一致してしまっています。意味（事実・関係・因果）を保ったまま、まったく別の言い回しの日本語に書き直してください。");
  lines.push(`${OWN_WORDS_RULE}。固有名はそのままでよい。${CLAIM_TEXT_TARGET}字以内。key はそのまま返す。`);
  lines.push("");
  for (const it of items) lines.push(`- key=${it.key}: ${it.text}`);
  return lines.join("\n");
}
