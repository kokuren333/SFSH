/** Completion-notice text for S4 (§5.2: counts and key points; at most 5 points). */
import { ADVISORY_TYPES, type AdvisoryType, type CheckReport } from "./types.ts";

export const ADVISORY_LABELS: Record<AdvisoryType, string> = {
  long_quote: "長い引用形",
  similar_to_source: "出典との類似",
  too_concrete_unresolved: "未解決の too_concrete",
  short_or_lyric_work: "詩・歌詞・短い作品",
  holder_policy: "権利者の方針の記録",
  title_provisional: "題名が仮（provisional）",
  over_guideline: "目安超過",
  chain_dropout: "連鎖脱落",
};

/** Order of importance for the points list. */
const POINT_ORDER: AdvisoryType[] = ["title_provisional", "holder_policy", "short_or_lyric_work", "too_concrete_unresolved", "similar_to_source", "long_quote", "chain_dropout", "over_guideline"];

export type NoticeInput = Pick<CheckReport, "a1" | "a2" | "advisory_counts">;

export function buildNotice(r: NoticeInput): { line: string; points: string[] } {
  const a1n = r.a1.detected.length;
  const a2n = r.a2.detected.length;
  const total = ADVISORY_TYPES.reduce((n, t) => n + (r.advisory_counts[t] ?? 0), 0);
  const parts = POINT_ORDER.filter((t) => (r.advisory_counts[t] ?? 0) > 0).map((t) => `${ADVISORY_LABELS[t]} ${r.advisory_counts[t]}`);
  const fixed = a1n + a2n > 0 ? "（該当箇所を修正済み）" : "";
  const line = `自動確認: A-1 検出 ${a1n}・A-2 検出 ${a2n}${fixed}／advisory ${total}件${parts.length ? `（${parts.join("・")}）` : ""}`;
  const points: string[] = [];
  if (a1n) {
    const sentences = r.a1.removed.filter((x) => x.action === "sentence_removed").length;
    const elements = r.a1.removed.filter((x) => x.action === "element_removed").length;
    points.push(`A-1: 出典と30字以上一致した文 ${a1n} → 書き直し ${r.a1.rewritten_ok}件・削除 ${sentences}文${elements ? `（要素 ${elements}件を除去）` : ""}`);
  }
  if (a2n) points.push(`A-2: 画像・メディアの混入 ${a2n}件を除去`);
  for (const t of POINT_ORDER) {
    if (points.length >= 5) break;
    const n = r.advisory_counts[t] ?? 0;
    if (n) points.push(`advisory: ${ADVISORY_LABELS[t]} ${n}件`);
  }
  return { line, points: points.slice(0, 5) };
}

/** Plain-text notice (line + bullet points). */
export function formatNotice(n: { line: string; points: string[] }): string {
  return [n.line, ...n.points.map((p) => `- ${p}`)].join("\n");
}
