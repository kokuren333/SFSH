/**
 * A-1 text contamination (§5.1): continuous verbatim runs (≥ 30 normalized chars) between generated strings
 * of gen/public.json and the saved source texts (research/raw/<sid>.txt + excerpts[].text). Normalization =
 * NFKC + whitespace removal (research/textMatch.ts). Proper nouns on the allowlist are removed from BOTH sides
 * before matching, so their characters never count toward the run (PLAN "固有名の許可リスト").
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PublicWork } from "../../../site/src/public-types.ts";
import { readSourceCards } from "../nkg/io.ts";
import type { Nkg } from "../nkg/types.ts";
import { normKey, normalizeForMatch } from "../research/textMatch.ts";
import type { Work } from "../works/types.ts";
import { sentenceSpans, type Span } from "./leaves.ts";
import { A1_RUN } from "./types.ts";

// ------------------------------------------------------------------ allowlist
/**
 * Proper-noun allowlist: work title / original title / aliases (work.json aliases[].text, public
 * aliases_display) / creator names / character labels / faction labels (public file and nkg). Normalized,
 * ≥ 2 chars, longest first.
 */
export function buildAllowlist(pw: PublicWork, work: Partial<Work> | null, nkg: Nkg | null): string[] {
  const raw: unknown[] = [
    pw.work.title,
    pw.work.title_original,
    ...pw.work.aliases_display,
    ...pw.work.creators.map((c) => c.name),
    ...pw.viz.relations.characters.map((c) => c.label),
    ...pw.viz.relations.factions.map((f) => f.label),
    work?.title,
    work?.title_original,
    ...(work?.aliases ?? []).map((a) => a?.text),
    ...(work?.creators ?? []),
    nkg?.work?.title,
    ...(nkg?.work?.title_alt ?? []),
    ...(nkg?.work?.creators ?? []).map((c) => c?.name),
    ...(nkg?.nodes ?? []).filter((n) => n.type === "Character" || n.type === "Faction").map((n) => n.label),
  ];
  const set = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const k = normKey(v);
    if ([...k].length >= 2) set.add(k);
  }
  return [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Reducer {
  terms: number;
  /** Normalized text with allowlist terms removed. */
  reduceNorm(norm: string): string;
  /** Original text → reduced normalized text + map back to original offsets. */
  reduce(orig: string): { s: string; map: number[] };
}

export function makeReducer(terms: string[]): Reducer {
  const re = terms.length ? new RegExp(terms.map(esc).join("|"), "g") : null;
  return {
    terms: terms.length,
    reduceNorm: (norm) => (re ? norm.replace(re, "") : norm),
    reduce: (orig) => {
      const n = normalizeForMatch(orig);
      if (!re) return { s: n.norm, map: n.map };
      let s = "";
      const map: number[] = [];
      let pos = 0;
      re.lastIndex = 0;
      for (const m of n.norm.matchAll(re)) {
        s += n.norm.slice(pos, m.index);
        for (let i = pos; i < m.index; i++) map.push(n.map[i]);
        pos = m.index + m[0].length;
      }
      s += n.norm.slice(pos);
      for (let i = pos; i < n.norm.length; i++) map.push(n.map[i]);
      return { s, map };
    },
  };
}

// ------------------------------------------------------------------ sources
export interface SourceCorpus {
  /** Original source texts (raw texts and excerpts), for the similarity advisory. Never written anywhere. */
  texts: string[];
  checked: number;
  missing: string[];
}

/** Saved raw text of every source card (raw_text_path, default research/raw/<sid>.txt) + excerpts[].text. */
export function readSourceCorpus(workDir: string): SourceCorpus {
  const texts: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  const root = path.resolve(workDir);
  for (const c of readSourceCards(workDir)) {
    if (!c || typeof c.source_id !== "string") continue;
    const rel = c.raw_text_path || `research/raw/${c.source_id}.txt`;
    const abs = path.resolve(root, rel);
    if (abs.startsWith(root + path.sep) && existsSync(abs)) {
      texts.push(readFileSync(abs, "utf8"));
      checked++;
    } else missing.push(c.source_id);
    for (const e of Array.isArray(c.excerpts) ? c.excerpts : []) if (typeof e?.text === "string" && e.text.trim()) texts.push(e.text);
  }
  return { texts, checked, missing };
}

export interface A1Index {
  reducer: Reducer;
  windows: Set<string>;
  run: number;
}

export function buildA1Index(corpus: SourceCorpus, reducer: Reducer, run = A1_RUN): A1Index {
  const windows = new Set<string>();
  for (const t of corpus.texts) {
    const r = reducer.reduceNorm(normKey(t));
    for (let i = 0; i + run <= r.length; i++) windows.add(r.slice(i, i + run));
  }
  return { reducer, windows, run };
}

/**
 * A sentence takes part in a matched run when at least this many of its (reduced) chars are in the run, or the
 * whole sentence is when it is shorter. Keeps a neighbour that only shares a boundary char (e.g. the "。" before
 * a copied sentence) from being flagged.
 */
export const MIN_SENTENCE_OVERLAP = 10;

/**
 * Sentences of `value` that take part in a verbatim run. Runs are searched on the whole string (so a copy that
 * crosses a sentence boundary is found too) and mapped back to sentence spans: per maximal run, every sentence
 * with ≥ MIN_SENTENCE_OVERLAP chars in it (or entirely in it) is flagged; if none qualifies, the sentence(s) with
 * the largest share are (so a run always flags something and the removal loop always progresses).
 */
export function flaggedSpans(value: string, idx: A1Index): Span[] {
  if (!idx.windows.size) return [];
  const r = idx.reducer.reduce(value);
  const n = r.s.length;
  if (n < idx.run) return [];
  const hit = new Uint8Array(n);
  let any = false;
  for (let i = 0; i + idx.run <= n; i++) {
    if (idx.windows.has(r.s.slice(i, i + idx.run))) {
      hit.fill(1, i, i + idx.run);
      any = true;
    }
  }
  if (!any) return [];
  const spans = sentenceSpans(value);
  const sentOf = new Int32Array(n).fill(-1);
  const lenOf = new Array<number>(spans.length).fill(0);
  for (let k = 0, s = 0; k < n; k++) {
    const o = r.map[k];
    while (s < spans.length && spans[s].end <= o) s++;
    if (s < spans.length && o >= spans[s].start) {
      sentOf[k] = s;
      lenOf[s]++;
    }
  }
  const flagged = new Set<number>();
  for (let k = 0; k < n; ) {
    if (!hit[k]) {
      k++;
      continue;
    }
    const overlap = new Map<number, number>();
    for (; k < n && hit[k]; k++) if (sentOf[k] >= 0) overlap.set(sentOf[k], (overlap.get(sentOf[k]) ?? 0) + 1);
    let cands = [...overlap].filter(([s, c]) => c >= Math.min(MIN_SENTENCE_OVERLAP, lenOf[s]));
    if (!cands.length && overlap.size) {
      const max = Math.max(...overlap.values());
      cands = [...overlap].filter(([, c]) => c === max);
    }
    for (const [s] of cands) flagged.add(s);
  }
  const out = spans.filter((_, i) => flagged.has(i));
  // A matched char always lies inside some sentence span; fall back to the whole value defensively.
  return out.length ? out : [{ start: 0, end: value.length, text: value }];
}

// ------------------------------------------------------------------ rewrite (one call per authoring model)
/** OpenAI-strict (usable for both ports). */
export const A1_REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
      },
    },
  },
} as const;

export interface RewriteItem {
  id: string;
  /** Display path, e.g. $.pages.overview[0].paragraphs[1]. */
  path: string;
  /** Field role for the model (見出し / ラベル / 要約 …). */
  role: string;
  text: string;
  flagged: string[];
}

const ROLE: Record<string, string> = {
  label: "ラベル（短い名詞句）",
  heading: "見出し",
  summary: "要約",
  analysis: "分析",
  paragraphs: "本文の段落",
  question: "問い",
  answer: "答え",
  explanation: "解説",
  claim: "解釈の立場",
  topic: "論点",
  tension: "緊張関係",
  values: "価値（短い語）",
  why_famous: "有名な理由",
  consequence: "帰結",
  meaning: "意味",
  initial_state: "初期状態",
  final_state: "最終状態",
  changed_by_label: "変化の契機（短いラベル）",
  kind: "関係（短いラベル）",
  emotion: "感情（短い語）",
  arc_type: "変容の型（短い語）",
  aspect_label: "観点名",
};
export const roleOf = (key: string | null): string => (key && ROLE[key]) || "文字列";

export function a1RewritePrompt(o: { title: string; items: RewriteItem[] }): string {
  return `作品『${o.title}』の公開ページの文字列のうち、下に示す「一致した文」が、保存済みの出典の文と長く一致していました（固有名を除いて30字以上の連続一致）。各項目の文字列を、意味を保ったまま自分の言葉で書き直してください。

- 一致した文は語順・語彙を変えて完全に言い換える。出典の言い回しを残さない。原作の台詞や文章を引用しない。鉤括弧で台詞を再現しない。
- 一致していない文は、そのまま残してよい。
- 内容を増やさない。根拠の無いことを足さない。固有名（人名・作品名・用語）はそのまま使ってよい。
- 画像・URL・HTML・Markdown を入れない。プレーンテキストのみ。
- 文字列の役割（見出し・ラベル・要約など）と長さの目安を保つ。ラベルは短い名詞句のまま。
- 項目ごとに items に {id, text} を1つ返す。text は書き直した文字列の全体。書き直せない項目は返さなくてよい（その場合、一致した文は削除されます）。

# 書き直す項目
${o.items.map((it) => `## ${it.id}（${it.role}・${it.path}）\n${it.text}\n一致した文:\n${it.flagged.map((s) => `- ${s}`).join("\n")}`).join("\n\n")}
`;
}
