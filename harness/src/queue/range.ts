/**
 * §4.1 range grammar (WP-4.3): 全体／N巻／N-M巻／N話／N-M話／第Nシーズン／「◯◯」編／劇場版. Omitted → 全体.
 * Deterministic. Input that cannot be parsed is never discarded: the caller keeps range_raw and asks back
 * (state clarifying, reason range_unparsed).
 *
 * Accepted variants (all after NFKC): 第N巻・第N話 (the 第 is optional), N巻-M巻, separators - ‐ ‑ – — − ~ 〜 ～ から,
 * 全N話 (= 1-N話), シーズンN・第N期 (= season), 『◯◯』編・◯◯編 (bare), 劇場版「◯◯」, kanji numerals (一〜九千九百九十九, 〇),
 * and several items joined by 、 or , (e.g. 「1-3巻、5巻」).
 */
import type { RangeItem, RangeUnit } from "./types.ts";

export const WHOLE: RangeItem = { unit: "whole", from: null, to: null, label: "全体" };
export const RANGE_MAX_NUMBER = 99_999;

export type RangeParse = { ok: true; items: RangeItem[] } | { ok: false; reason: string };

const SEP = "(?:-|‐|‑|–|—|−|~|〜|～|から)";
const KANJI_DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** Kanji numeral (一〜九千九百九十九, digit strings like 二〇 too) → number, or null. */
export function kanjiToNumber(s: string): number | null {
  if (!s || !/^[〇零一二三四五六七八九十百千]+$/.test(s)) return null;
  if (!/[十百千]/.test(s)) {
    // positional digits: 二〇 → 20
    let n = 0;
    for (const ch of s) n = n * 10 + KANJI_DIGITS[ch]!;
    return n;
  }
  let total = 0;
  let digit = -1;
  let lastUnit = Infinity;
  for (const ch of s) {
    if (ch in KANJI_DIGITS) {
      if (digit >= 0) return null; // two digits in a row inside a unit form
      digit = KANJI_DIGITS[ch]!;
    } else {
      const u = KANJI_UNITS[ch]!;
      if (u >= lastUnit) return null; // 十百, 十十
      total += (digit < 0 ? 1 : digit) * u;
      digit = -1;
      lastUnit = u;
    }
  }
  if (digit >= 0) total += digit;
  return total;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return kanjiToNumber(s);
}

const N = "(\\d+|[〇零一二三四五六七八九十百千]+)";

function span(unit: RangeUnit, a: number | null, b: number | null, suffix: string): RangeItem | string {
  if (a === null || b === null) return "数字を読めません";
  if (a < 1 || b < 1) return "番号は1以上です";
  if (a > RANGE_MAX_NUMBER || b > RANGE_MAX_NUMBER) return "番号が大きすぎます";
  if (a > b) return `範囲の始まり（${a}）が終わり（${b}）より大きいです`;
  const label = unit === "season" ? (a === b ? `第${a}シーズン` : `第${a}-${b}シーズン`) : a === b ? `${a}${suffix}` : `${a}-${b}${suffix}`;
  return { unit, from: a, to: b, label };
}

function stripQuotes(s: string): string {
  return s.replace(/^[「『"“]\s*/, "").replace(/\s*[」』"”]$/, "").trim();
}

/** Parse one item (no 、/, inside). Returns the item or a Japanese reason. */
function parseItem(s: string): RangeItem | string {
  if (s === "全体" || s === "whole" || s === "全巻" || s === "全話" || s === "全編" || s === "全部") return { ...WHOLE };
  let m: RegExpMatchArray | null;
  // 全N話 = 1..N
  if ((m = s.match(new RegExp(`^全${N}話$`)))) return span("episode", 1, num(m[1]), "話");
  // volume / episode: 第N巻, N-M巻, 第N巻-第M巻, N巻-M巻
  for (const [unit, suf] of [
    ["volume", "巻"],
    ["episode", "話"],
  ] as const) {
    if ((m = s.match(new RegExp(`^第?${N}${suf}?\\s*${SEP}\\s*第?${N}${suf}$`)))) return span(unit, num(m[1]), num(m[2]), suf);
    if ((m = s.match(new RegExp(`^第?${N}${suf}$`)))) return span(unit, num(m[1]), num(m[1]), suf);
  }
  // season: 第Nシーズン, 第N-Mシーズン, シーズンN, 第N期
  if ((m = s.match(new RegExp(`^第?${N}\\s*${SEP}\\s*第?${N}(?:シーズン|期)$`)))) return span("season", num(m[1]), num(m[2]), "");
  if ((m = s.match(new RegExp(`^第?${N}(?:シーズン|期)$`)))) return span("season", num(m[1]), num(m[1]), "");
  if ((m = s.match(new RegExp(`^(?:シーズン|season\\s*)${N}$`, "i")))) return span("season", num(m[1]), num(m[1]), "");
  // film: 劇場版 / 劇場版「◯◯」
  if ((m = s.match(/^劇場版\s*(.*)$/))) {
    const name = stripQuotes(m[1] ?? "");
    if (name && /^[」』]/.test(name)) return "劇場版の題名を読めません";
    return { unit: "film", from: null, to: null, label: name ? `劇場版「${name}」` : "劇場版" };
  }
  // arc: 「◯◯」編 / 『◯◯』編 / ◯◯編
  if ((m = s.match(/^[「『](.+)[」』]\s*編$/))) {
    const name = m[1]!.trim();
    if (!name) return "編の名前が空です";
    return { unit: "arc", from: null, to: null, label: `「${name}」編` };
  }
  if ((m = s.match(/^(.+?)\s*編$/))) {
    const name = m[1]!.trim();
    if (!name || /^[\d〇零一二三四五六七八九十百千第全]+$/.test(name) || /[「」『』]/.test(name)) return "編の名前を読めません";
    return { unit: "arc", from: null, to: null, label: `「${name}」編` };
  }
  return "範囲の書き方を解釈できません（例: 全体／3巻／1-3巻／5話／1-12話／第2シーズン／「◯◯」編／劇場版）";
}

/** Parse a whole range string. Empty / whitespace / null → [全体]. */
export function parseRange(raw: string | null | undefined): RangeParse {
  const s = (raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (s === "") return { ok: true, items: [{ ...WHOLE }] };
  const parts = splitItems(s);
  const items: RangeItem[] = [];
  for (const p of parts) {
    if (!p) return { ok: false, reason: "空の項目があります" };
    const r = parseItem(p);
    if (typeof r === "string") return { ok: false, reason: `「${p}」: ${r}` };
    items.push(r);
  }
  if (items.length > 1 && items.some((i) => i.unit === "whole")) return { ok: false, reason: "「全体」と他の範囲は同時に指定できません" };
  // de-duplicate identical items, keep input order
  const seen = new Set<string>();
  const out = items.filter((i) => {
    const k = itemKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ok: true, items: out };
}

/** Split on 、 and , that are outside 「」『』 quotes. */
function splitItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "「" || ch === "『") depth++;
    else if ((ch === "」" || ch === "』") && depth > 0) depth--;
    if (depth === 0 && (ch === "、" || ch === ",")) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normLabel(s: string): string {
  return s.normalize("NFKC").replace(/[\s「」『』"“”]/g, "").toLowerCase();
}

function itemKey(i: RangeItem): string {
  if (i.unit === "whole") return "whole";
  if (i.unit === "arc" || i.unit === "film") return `${i.unit}:${normLabel(i.label)}`;
  return `${i.unit}:${i.from}-${i.to}`;
}

const UNIT_ORDER: RangeUnit[] = ["whole", "season", "volume", "episode", "arc", "film"];

/** Canonical key of a parsed range (order-independent), used in the idempotency key (§4.4). */
export function rangeKey(items: RangeItem[] | null | undefined): string {
  if (!items || items.length === 0) return "whole";
  return [...new Set(items.map(itemKey))]
    .sort((a, b) => {
      const ua = UNIT_ORDER.indexOf(a.split(":")[0] as RangeUnit);
      const ub = UNIT_ORDER.indexOf(b.split(":")[0] as RangeUnit);
      if (ua !== ub) return ua - ub;
      const na = Number(a.split(":")[1]?.split("-")[0]);
      const nb = Number(b.split(":")[1]?.split("-")[0]);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .join(",");
}

/** Display form, e.g. "1-3巻・5巻". */
export function formatRange(items: RangeItem[] | null | undefined): string {
  if (!items || items.length === 0) return "全体";
  return items.map((i) => i.label || (i.unit === "whole" ? "全体" : "")).join("・");
}
