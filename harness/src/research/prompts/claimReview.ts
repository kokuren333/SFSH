import { ASPECT_GUIDE, OWN_WORDS_RULE } from "./common.ts";

/** Schema for s1.claims.review (Haiku). Written strict-compatible as well. */
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_id", "type", "severity", "evidence", "missing_aspect", "suggested_query"],
        properties: {
          target_id: { type: ["string", "null"] },
          type: { type: "string", enum: ["unsupported", "overreach", "copied_phrase", "misclassified", "missing"] },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          evidence: { type: "string" },
          missing_aspect: { type: ["string", "null"] },
          suggested_query: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export interface ReviewItem {
  claim_id: string;
  text: string;
  aspects: string[];
  epistemic: string;
  source_id: string;
  /** Evidence span ±150 chars, read from raw text at runtime (never stored). */
  context: string;
}

export function buildReviewPrompt(workTitle: string, items: ReviewItem[], coveredAspects: Record<string, number>): string {
  const lines: string[] = [];
  lines.push(`あなたは物語作品『${workTitle}』の調査結果のレビュー担当です。各 claim を、添えた出典本文の周辺と突き合わせて問題を指摘してください。書き換えはしません。指摘だけを返します。`);
  lines.push("");
  lines.push("## 指摘の種類（type）");
  lines.push("- unsupported: 添えた出典本文がその claim を支持していない。");
  lines.push("- overreach: 出典から言える範囲を超えた推論・一般化。");
  lines.push("- copied_phrase: claim の文が出典の文や言い回しを写している（固有名の一致は問題ない）。");
  lines.push("- misclassified: epistemic（canon / consensus / fan_theory）や観点の区分が誤り。");
  lines.push("- missing: 作品理解に必要なのに claim が足りない観点。target_id は null、missing_aspect に観点 ID（下の一覧。当てはまらなければ短い日本語）、suggested_query に追加検索の語を書く。");
  lines.push("");
  lines.push("## 規則");
  lines.push("- 問題のない claim には何も返さない。findings が空でもよい。");
  lines.push("- evidence にはなぜそう判断したかを自分の言葉で短く書く（出典の文を長く写さない）。");
  lines.push(`- 作成側への原則: ${OWN_WORDS_RULE}。`);
  lines.push("");
  lines.push("観点 ID:");
  lines.push(ASPECT_GUIDE);
  lines.push("");
  lines.push("## 現在の観点ごとの claim 数（全体）");
  lines.push(Object.entries(coveredAspects).map(([k, v]) => `${k}:${v}`).join(" ") || "（なし）");
  lines.push("");
  lines.push("## claim 一覧");
  for (const it of items) {
    lines.push(`<claim id="${it.claim_id}" source="${it.source_id}" epistemic="${it.epistemic}" aspects="${it.aspects.join(",")}">`);
    lines.push(`主張: ${it.text}`);
    lines.push(`出典本文の周辺: ${it.context}`);
    lines.push("</claim>");
  }
  return lines.join("\n");
}

/** OpenAI-strict schema for s1.claims.revise (Luna). */
export const REVISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim_id", "action", "text", "epistemic", "reason"],
        properties: {
          claim_id: { type: "string" },
          action: { type: "string", enum: ["revise", "drop", "keep"] },
          text: { type: ["string", "null"] },
          epistemic: { type: ["string", "null"], enum: ["canon", "consensus", "fan_theory", null] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ReviseItem {
  claim_id: string;
  text: string;
  epistemic: string;
  context: string;
  findings: { type: string; severity: string; evidence: string }[];
}

export function buildRevisePrompt(workTitle: string, items: ReviseItem[]): string {
  const lines: string[] = [];
  lines.push(`物語作品『${workTitle}』について、あなたが作った claim にレビューの指摘が付きました。claim ごとに1つ、対応を返してください。`);
  lines.push("");
  lines.push(`## 原則: ${OWN_WORDS_RULE}。`);
  lines.push("- revise: 指摘に従って直す。text に直した文（日本語、自分の言葉、160字以内。文を直さず区分だけ直すときは null）、epistemic に直した区分（変えないなら null）。");
  lines.push("- drop: 出典が支持しない・直しようがないので取り下げる。");
  lines.push("- keep: 指摘が当たらないので直さない。reason に理由を書く。");
  lines.push("- copied_phrase の指摘は、言い換える（revise）か取り下げる（drop）。写しのまま keep した claim は削除される。");
  lines.push("- 出典本文の周辺に書かれていないことを足さない。");
  lines.push("");
  for (const it of items) {
    lines.push(`<claim id="${it.claim_id}" epistemic="${it.epistemic}">`);
    lines.push(`主張: ${it.text}`);
    lines.push(`出典本文の周辺: ${it.context}`);
    for (const f of it.findings) lines.push(`指摘[${f.type}/${f.severity}]: ${f.evidence}`);
    lines.push("</claim>");
  }
  return lines.join("\n");
}
