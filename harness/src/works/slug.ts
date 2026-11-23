/**
 * Deterministic kana → romaji (Hepburn, ASCII long vowels) and work_id construction (§1.4).
 * work_id = <medium>-<slug>-<first release year | "unknown">; never changes once created.
 *
 * Rules:
 *  - hiragana and katakana (half-width katakana via NFKC); small-kana digraphs (きゃ kya, しゃ sha, ちゃ cha,
 *    じゃ ja, ファ fa, ティ ti, ディ di, ウィ wi, ヴァ va, シェ she, ...).
 *  - っ/ッ doubles the next consonant (っち → tchi); at a word end or before a non-consonant it is dropped.
 *  - ー repeats the previous vowel (ゲーム → geemu). Long vowels are written as typed (おう → ou), no macrons.
 *  - ん before a vowel or y becomes "n'" in kanaToRomaji (Hepburn); the apostrophe is removed in slugs.
 *    ん before b/m/p stays "n" (modified Hepburn).
 *  - を → "o", ぢ → "ji", づ → "zu", ゐ → "i", ゑ → "e". Particles are not guessed (は stays "ha").
 *  - ASCII / Latin letters and digits pass through (diacritics stripped, lowercased).
 *  - Any other symbol (・☆! etc.) separates words.
 *  - Kanji (or any other script) throws: the caller must supply a kana reading.
 */

const BASE: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n",
  ゔ: "vu",
  // standalone small kana
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o", ゃ: "ya", ゅ: "yu", ょ: "yo", ゎ: "wa", ゕ: "ka", ゖ: "ke",
};

/** Two-kana combinations (base + small kana). Keys are hiragana. */
const DIGRAPH: Record<string, string> = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyo", ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho", じゃ: "ja", じゅ: "ju", じょ: "jo",
  ちゃ: "cha", ちゅ: "chu", ちょ: "cho", ぢゃ: "ja", ぢゅ: "ju", ぢょ: "jo",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo", ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  びゃ: "bya", びゅ: "byu", びょ: "byo", ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo", りゃ: "rya", りゅ: "ryu", りょ: "ryo",
  // loanword combinations (mostly katakana; matched after kata→hira folding)
  しぇ: "she", じぇ: "je", ちぇ: "che", いぇ: "ye",
  てぃ: "ti", でぃ: "di", てゅ: "tyu", でゅ: "dyu", とぅ: "tu", どぅ: "du",
  つぁ: "tsa", つぃ: "tsi", つぇ: "tse", つぉ: "tso",
  ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo", ふゅ: "fyu",
  うぃ: "wi", うぇ: "we", うぉ: "wo",
  ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo", ゔゅ: "vyu",
  くぁ: "kwa", くぃ: "kwi", くぇ: "kwe", くぉ: "kwo", ぐぁ: "gwa",
  すぃ: "si", ずぃ: "zi",
};

const SMALL_TSU = new Set(["っ"]);
const VOWELS = new Set(["a", "i", "u", "e", "o"]);

/** Fold katakana (incl. ヴ, ヵ, ヶ) to hiragana. Leaves ー and everything else untouched. */
export function kataToHira(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x30a1 && cp <= 0x30f6) out += String.fromCodePoint(cp - 0x60);
    else out += ch;
  }
  return out;
}

function isKana(ch: string): boolean {
  return ch in BASE || SMALL_TSU.has(ch) || ch === "ー";
}

/** Romanize one word (no whitespace). Throws on kanji / unsupported script. */
function romanizeWord(word: string): string[] {
  // returns a list of word pieces: symbols split words
  const pieces: string[] = [];
  let cur = "";
  let geminate = false;
  const chars = [...kataToHira(word)];
  const flush = () => {
    if (cur) pieces.push(cur);
    cur = "";
    geminate = false;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (isKana(ch)) {
      if (SMALL_TSU.has(ch)) {
        geminate = true;
        continue;
      }
      if (ch === "ー") {
        const last = cur.at(-1);
        if (last && VOWELS.has(last)) cur += last;
        geminate = false;
        continue;
      }
      let syl: string;
      const pair = ch + (chars[i + 1] ?? "");
      if (DIGRAPH[pair]) {
        syl = DIGRAPH[pair];
        i++;
      } else {
        syl = BASE[ch];
      }
      if (ch === "ん") {
        const nextCh = chars[i + 1];
        const next = nextCh && nextCh in BASE ? BASE[nextCh] : "";
        if (next && (VOWELS.has(next[0]) || next[0] === "y")) syl = "n'";
      }
      if (geminate) {
        if (syl.startsWith("ch")) syl = "t" + syl;
        else if (/^[bcdfghjklmpqrstvwxz]/.test(syl)) syl = syl[0] + syl;
        geminate = false;
      }
      cur += syl;
      continue;
    }
    geminate = false;
    // Latin letters / digits (diacritics stripped)
    const latin = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (/^[A-Za-z0-9]+$/.test(latin)) {
      cur += latin.toLowerCase();
      continue;
    }
    if (/\p{Script=Han}/u.test(ch) || /\p{L}/u.test(ch)) {
      throw new Error(`reading contains non-kana letter "${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase()}); supply a kana reading`);
    }
    // symbol / punctuation → word break
    flush();
  }
  flush();
  return pieces;
}

/** Hepburn romanization of a kana reading. Words stay separated by single spaces. */
export function kanaToRomaji(reading: string): string {
  const words = reading.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  return words.flatMap((w) => romanizeWord(w)).join(" ");
}

export const SLUG_MAX = 60;

/** Slug: lowercase ASCII words joined by "-", at most SLUG_MAX chars (cut at a word boundary when possible). */
export function slugify(reading: string): string {
  const words = kanaToRomaji(reading)
    .split(" ")
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  let slug = words.join("-");
  if (slug.length > SLUG_MAX) {
    const cut = slug.slice(0, SLUG_MAX);
    const lastDash = cut.lastIndexOf("-");
    slug = lastDash >= 20 ? cut.slice(0, lastDash) : cut.replace(/-+$/, "");
  }
  if (!slug) throw new Error(`reading "${reading}" yields an empty slug`);
  return slug;
}

/** work_id = <medium>-<slug>-<year|unknown> (§1.4). */
export function makeWorkId(medium: string, readingWithSpaces: string, year: number | null): string {
  const m = medium.trim().toLowerCase();
  if (!/^[a-z]+$/.test(m)) throw new Error(`invalid medium "${medium}"`);
  const y = year === null || year === undefined ? "unknown" : String(year);
  if (y !== "unknown" && !/^\d{3,4}$/.test(y)) throw new Error(`invalid year "${year}"`);
  return `${m}-${slugify(readingWithSpaces)}-${y}`;
}
