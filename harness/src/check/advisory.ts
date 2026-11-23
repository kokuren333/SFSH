/**
 * §5.2 advisory (PLAN "advisory" table). Recorded in check/report.json and summarized in the completion notice.
 * Never used to pass / stop anything (P-1). Details never copy source or generated text.
 */
import type { PublicWork } from "../../../site/src/public-types.ts";
import { readJson } from "../nkg/io.ts";
import type { Nkg } from "../nkg/types.ts";
import { normKey } from "../research/textMatch.ts";
import type { Work } from "../works/types.ts";
import type { Reducer, SourceCorpus } from "./a1.ts";
import { fmtPath, inA1Scope, sentenceSpans, stringLeaves } from "./leaves.ts";
import { ADVISORY_TYPES, LONG_QUOTE_CHARS, SIMILARITY, type AdvisoryItem, type AdvisoryType } from "./types.ts";

const QUOTE_RE = /「([^「」]*)」|『([^『』]*)』/g;

export function longQuotes(pw: PublicWork, minChars = LONG_QUOTE_CHARS): AdvisoryItem[] {
  const out: AdvisoryItem[] = [];
  for (const l of stringLeaves(pw)) {
    if (!inA1Scope(l.path)) continue;
    for (const m of l.value.matchAll(QUOTE_RE)) {
      const n = [...normKey(m[1] ?? m[2] ?? "")].length;
      if (n >= minChars) out.push({ type: "long_quote", target: fmtPath(l.path), detail: `鉤括弧内が${n}字（目安${minChars}字以上）` });
    }
  }
  return out;
}

function grams(s: string, n: number): Set<string> {
  const g = new Set<string>();
  const cs = [...s];
  for (let i = 0; i + n <= cs.length; i++) g.add(cs.slice(i, i + n).join(""));
  return g;
}

/**
 * Sentence-level similarity: each generated sentence (normalized, allowlist removed, ≥ min_chars) against every
 * source sentence; 3-gram Jaccard > jaccard_gt → one advisory per generated sentence (best match).
 * Candidate pruning is exact: J > t needs |A∩B| > t·|A|, so pairs whose shared-gram count cannot reach it are skipped.
 */
export function similarToSource(pw: PublicWork, corpus: SourceCorpus, reducer: Reducer, p: { ngram: number; jaccard_gt: number; min_chars: number } = SIMILARITY): AdvisoryItem[] {
  const srcSets: Set<string>[] = [];
  const index = new Map<string, number[]>();
  for (const t of corpus.texts) {
    for (const sp of sentenceSpans(t)) {
      const r = reducer.reduceNorm(normKey(sp.text));
      if ([...r].length < p.ngram) continue;
      const g = grams(r, p.ngram);
      const id = srcSets.length;
      srcSets.push(g);
      for (const x of g) {
        const list = index.get(x);
        if (list) list.push(id);
        else index.set(x, [id]);
      }
    }
  }
  if (!srcSets.length) return [];
  const out: AdvisoryItem[] = [];
  for (const l of stringLeaves(pw)) {
    if (!inA1Scope(l.path)) continue;
    let best = 0;
    let bestChars = 0;
    for (const sp of sentenceSpans(l.value)) {
      const r = reducer.reduceNorm(normKey(sp.text));
      const chars = [...r].length;
      if (chars < p.min_chars) continue;
      const a = grams(r, p.ngram);
      const counts = new Map<number, number>();
      for (const x of a) for (const id of index.get(x) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, inter] of counts) {
        if (inter <= p.jaccard_gt * a.size) continue;
        const b = srcSets[id];
        const j = inter / (a.size + b.size - inter);
        if (j > p.jaccard_gt && j > best) {
          best = j;
          bestChars = chars;
        }
      }
    }
    if (best > 0) out.push({ type: "similar_to_source", target: fmtPath(l.path), detail: `出典の文と3-gram類似度${best.toFixed(2)}（${bestChars}字の文。目安${p.jaccard_gt}超）` });
  }
  return out;
}

interface AdvisoryLike {
  target_id?: unknown;
  type?: unknown;
}

/** Unresolved too_concrete from S2 / S3 review files (advisory = unresolved findings of kept elements). */
export function tooConcrete(workDir: string, pw: PublicWork): AdvisoryItem[] {
  const present = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const id = (v as { id?: unknown }).id;
      if (typeof id === "string") present.add(id);
      Object.values(v).forEach(walk);
    }
  };
  walk(pw);
  const files: [string, string][] = [
    ["nkg/reviews/fact.json", "事実層レビュー"],
    ["nkg/reviews/interp.json", "解釈層レビュー"],
    ["gen/reviews/pages.json", "本文レビュー"],
    ["gen/write_report.json", "本文レビュー"],
  ];
  const out: AdvisoryItem[] = [];
  const seen = new Set<string>();
  for (const [rel, label] of files) {
    let data: { advisory?: unknown } | null = null;
    try {
      data = readJson<{ advisory?: unknown } | null>(workDir, rel, null);
    } catch {
      data = null;
    }
    const list = Array.isArray(data?.advisory) ? (data!.advisory as AdvisoryLike[]) : [];
    for (const a of list) {
      if (a?.type !== "too_concrete" || typeof a.target_id !== "string") continue;
      const key = `${rel}:${a.target_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: "too_concrete_unresolved", target: a.target_id, detail: `${label}で未解決の too_concrete（場面の再話に近い）`, in_public: present.has(a.target_id) });
    }
  }
  return out;
}

const LYRIC_RE = /詩|歌詞|短歌|俳句|川柳|短編|掌編|poem|poetry|lyric|haiku|tanka|short_stor|flash_fiction/i;

export function shortOrLyric(pw: PublicWork, nkg: Nkg | null, vocabLabels: Map<string, string>): AdvisoryItem[] {
  const strs = [...pw.work.genres, ...pw.work.tags, ...(Array.isArray(nkg?.work?.genres) ? nkg!.work.genres : [])].filter((s): s is string => typeof s === "string");
  const hits = [...new Set(strs.filter((s) => LYRIC_RE.test(s) || LYRIC_RE.test(vocabLabels.get(s) ?? "")))];
  return hits.length ? [{ type: "short_or_lyric_work", target: "work", detail: `ジャンル・タグが詩・歌詞・短い作品を示す（${hits.join(", ")}）` }] : [];
}

export function holderPolicy(nkg: Nkg | null): AdvisoryItem[] {
  const note = nkg?.work?.rights?.holder_policy_note;
  if (typeof note !== "string" || !note.trim()) return [];
  return [{ type: "holder_policy", target: "work", detail: `権利者の方針に関する記録あり（${[...note.trim()].length}字。nkg.work.rights.holder_policy_note）` }];
}

export function titleProvisional(work: Partial<Work> | null): AdvisoryItem[] {
  return work?.title_status === "provisional" ? [{ type: "title_provisional", target: "work", detail: "題名が provisional（出典で確定していない）。公開は止めない" }] : [];
}

/** §2.4 guideline overages = validation warnings with the "soft:" prefix (nkg/validate.ts). */
export function overGuideline(workDir: string): AdvisoryItem[] {
  let v: { warnings?: unknown } | null = null;
  try {
    v = readJson<{ warnings?: unknown } | null>(workDir, "nkg/validation.json", null);
  } catch {
    v = null;
  }
  const out: AdvisoryItem[] = [];
  for (const w of Array.isArray(v?.warnings) ? (v!.warnings as unknown[]) : []) {
    if (typeof w !== "string" || !/^soft:/.test(w)) continue;
    const owner = /^soft:\s*([A-Za-z]+\d+)\.[a-z_]+\s/.exec(w)?.[1];
    out.push({ type: "over_guideline", target: owner ?? "work", detail: w.slice(0, 160) });
  }
  return out;
}

/** gen/projection.json `chain_dropout.count` (added by WP R; tolerated when absent). */
export function chainDropout(workDir: string): AdvisoryItem[] {
  let p: { chain_dropout?: { count?: unknown } } | null = null;
  try {
    p = readJson<{ chain_dropout?: { count?: unknown } } | null>(workDir, "gen/projection.json", null);
  } catch {
    p = null;
  }
  const n = Number(p?.chain_dropout?.count ?? 0);
  return Number.isFinite(n) && n > 0 ? [{ type: "chain_dropout", target: "work", detail: `根の要素が公開条件を満たさず連鎖的に外れた要素 ${n}件` }] : [];
}

export function countAdvisory(items: AdvisoryItem[]): Record<AdvisoryType, number> {
  const c = Object.fromEntries(ADVISORY_TYPES.map((t) => [t, 0])) as Record<AdvisoryType, number>;
  for (const a of items) c[a.type]++;
  return c;
}

export function computeAdvisory(o: {
  workDir: string;
  pw: PublicWork;
  work: Partial<Work> | null;
  nkg: Nkg | null;
  corpus: SourceCorpus;
  reducer: Reducer;
  vocabLabels: Map<string, string>;
}): AdvisoryItem[] {
  return [
    ...titleProvisional(o.work),
    ...holderPolicy(o.nkg),
    ...shortOrLyric(o.pw, o.nkg, o.vocabLabels),
    ...tooConcrete(o.workDir, o.pw),
    ...similarToSource(o.pw, o.corpus, o.reducer),
    ...longQuotes(o.pw),
    ...chainDropout(o.workDir),
    ...overGuideline(o.workDir),
  ];
}
