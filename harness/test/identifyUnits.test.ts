import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyMediumHint, decideTitleStatus, groupCandidates, normalizeReading, type VerifiedCandidate } from "../src/research/identify/decide.ts";
import { matchIndex, normalizeQuery } from "../src/research/identify/normalize.ts";
import { capSearchEvents } from "../src/research/identify/index.ts";
import type { SourceCard, Tier } from "../src/research/types.ts";
import { addAlias } from "../src/works/aliases.ts";
import { kanaToRomaji, makeWorkId, slugify } from "../src/works/slug.ts";
import { readIndex, readWork, rebuildIndex, writeWork } from "../src/works/store.ts";
import { INDEX_FIELDS, type IndexEntry, type Work } from "../src/works/types.ts";

function work(over: Partial<Work> = {}): Work {
  return {
    work_id: "anime-mahoushoujo-madoka-magika-2011", title: "魔法少女まどか☆マギカ", title_original: null, title_reading: "まほうしょうじょ まどか まぎか",
    title_reading_basis: "source", title_status: "confirmed", title_source_ids: ["s1"], aliases: [], medium: "anime", creators: [], genres: [], tags: [],
    first_release_year: 2011, publish_mode: "Public", history: [{ at: "x", event: "created", job_id: "j" }], first_published_at: null, updated_at: null,
    created_at: "2026-11-23T10:00:00+09:00", ...over,
  };
}

// ------------------------------------------------------------------ slug / work_id

test("makeWorkId: example from the spec and §1.4", () => {
  assert.equal(makeWorkId("anime", "まほうしょうじょ まどか まぎか", 2011), "anime-mahoushoujo-madoka-magika-2011");
  assert.equal(makeWorkId("novel", "はしれ めろす", 1940), "novel-hashire-merosu-1940");
  assert.equal(makeWorkId("novel", "はしれ めろす", null), "novel-hashire-merosu-unknown");
  assert.equal(makeWorkId("Film", "とき を かける しょうじょ", 2006), "film-toki-o-kakeru-shoujo-2006");
});

test("kanaToRomaji: Hepburn rules (digraphs, っ, ー, ん, katakana, small kana)", () => {
  assert.equal(kanaToRomaji("がっこう"), "gakkou");
  assert.equal(kanaToRomaji("まっちゃ"), "matcha");
  assert.equal(kanaToRomaji("きっぷ"), "kippu");
  assert.equal(kanaToRomaji("しゃしん ちゅうしゃ じょせい"), "shashin chuusha josei");
  assert.equal(kanaToRomaji("ゲーム"), "geemu");
  assert.equal(kanaToRomaji("らーめん"), "raamen");
  assert.equal(kanaToRomaji("きんえん"), "kin'en");
  assert.equal(kanaToRomaji("こんや"), "kon'ya");
  assert.equal(kanaToRomaji("しんぶん"), "shinbun");
  assert.equal(kanaToRomaji("ファイナル ファンタジー"), "fainaru fantajii");
  assert.equal(kanaToRomaji("ヴァイオレット エヴァーガーデン"), "vaioretto evaagaaden");
  assert.equal(kanaToRomaji("ティー パーティー"), "tii paatii");
  assert.equal(kanaToRomaji("ディズニー"), "dizunii");
  assert.equal(kanaToRomaji("ウェブ"), "webu");
  assert.equal(kanaToRomaji("ぁ"), "a");
  assert.equal(kanaToRomaji("ﾏﾄﾞｶ"), "madoka", "half-width katakana via NFKC");
  assert.equal(kanaToRomaji("ちぢみ つづく"), "chijimi tsuzuku");
  assert.equal(kanaToRomaji("を"), "o");
  assert.equal(kanaToRomaji("あっ"), "a", "trailing っ dropped");
});

test("slugify: ASCII / Latin pass through, symbols split words, apostrophes removed, ≤60 chars", () => {
  assert.equal(slugify("ONE PIECE"), "one-piece");
  assert.equal(slugify("Pokémon"), "pokemon");
  assert.equal(slugify("ＳＰＹ×ＦＡＭＩＬＹ"), "spy-family");
  assert.equal(slugify("まどか☆まぎか"), "madoka-magika");
  assert.equal(slugify("きんえん"), "kinen");
  assert.equal(slugify("すずみや はるひ の ゆううつ 2"), "suzumiya-haruhi-no-yuuutsu-2");
  const long = slugify("あいうえお かきくけこ さしすせそ たちつてと なにぬねの はひふへほ まみむめも やゆよ らりるれろ");
  assert.ok(long.length <= 60, long);
  assert.ok(!long.endsWith("-"));
  assert.match(makeWorkId("anime", "あいうえお かきくけこ さしすせそ たちつてと なにぬねの はひふへほ まみむめも", 2000), /^anime-[a-z0-9-]{1,60}-2000$/);
});

test("slug: kanji or other scripts throw; caller must supply kana", () => {
  assert.throws(() => makeWorkId("anime", "魔法少女 まどか", 2011), /non-kana/);
  assert.throws(() => slugify("ひび々"), /non-kana/);
  assert.throws(() => slugify("☆☆"), /empty slug/);
  assert.throws(() => makeWorkId("an ime", "あ", 2000), /invalid medium/);
});

// ------------------------------------------------------------------ normalizeQuery / matchIndex

test("normalizeQuery: NFKC, trim, collapse whitespace", () => {
  assert.equal(normalizeQuery("　まどか　 マギカ \n"), "まどか マギカ");
  assert.equal(normalizeQuery("ＡＢＣ１２３"), "ABC123");
  assert.equal(normalizeQuery("ﾏﾄﾞｶ"), "マドカ");
  assert.equal(normalizeQuery("魔法少女まどか★マギカ"), "魔法少女まどか★マギカ", "★ is not folded to ☆");
});

test("matchIndex: title / title_original / title_reading / aliases, 0-1-many", () => {
  const entries: IndexEntry[] = [
    { work_id: "a", title: "魔法少女まどか☆マギカ", title_original: null, title_reading: "まほうしょうじょ まどか まぎか", title_status: "confirmed",
      aliases: [{ text: "まどマギ", kind: "common", attested: true, source_ids: [], origin_job_id: "", first_seen: "" }], medium: "anime", creators: [], genres: [], tags: [],
      publish_mode: "Public", first_published_at: null, updated_at: null },
    { work_id: "b", title: "時をかける少女", title_original: null, title_reading: "とき を かける しょうじょ", title_status: "confirmed", aliases: [], medium: "novel",
      creators: [], genres: [], tags: [], publish_mode: "Public", first_published_at: null, updated_at: null },
    { work_id: "c", title: "時をかける少女", title_original: "The Girl Who Leapt Through Time", title_reading: null, title_status: "confirmed", aliases: [], medium: "film",
      creators: [], genres: [], tags: [], publish_mode: "Public", first_published_at: null, updated_at: null },
  ];
  assert.deepEqual(matchIndex("ま ど マ ギ", entries), []);
  assert.deepEqual(matchIndex("  まどマギ ", entries), ["a"]);
  assert.deepEqual(matchIndex("まほうしょうじょ　まどか　まぎか", entries), ["a"]);
  assert.deepEqual(matchIndex("魔法少女まどか☆マギカ", { works: entries }), ["a"]);
  assert.deepEqual(matchIndex("ｔｈｅ girl who leapt through time", entries), [], "case-sensitive (NFKC only)");
  assert.deepEqual(matchIndex("The Girl Who Leapt Through Time", entries), ["c"]);
  assert.deepEqual(matchIndex("時をかける少女", entries), ["b", "c"]);
  assert.deepEqual(matchIndex("", entries), []);
});

// ------------------------------------------------------------------ ledger

test("writeWork is atomic (no temp left) and readWork round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-works-"));
  const wd = path.join(dir, "w");
  writeWork(wd, work());
  writeWork(wd, work({ title_status: "provisional" }));
  assert.deepEqual(fs.readdirSync(wd), ["work.json"]);
  assert.equal(readWork(wd).title_status, "provisional");
});

test("rebuildIndex: exactly the §4.6 fields, sorted by work_id, skips _staging-* and dirs without work.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-works-"));
  writeWork(path.join(dir, "novel-b-2000"), work({ work_id: "novel-b-2000", title: "B" }));
  writeWork(path.join(dir, "anime-a-2011"), work({ work_id: "anime-a-2011", title: "A" }));
  writeWork(path.join(dir, "_staging-job1"), work({ work_id: "staged", title: "S" }));
  fs.mkdirSync(path.join(dir, "empty-dir"));
  const idx = rebuildIndex(dir);
  assert.deepEqual(idx.works.map((e) => e.work_id), ["anime-a-2011", "novel-b-2000"]);
  for (const e of idx.works) assert.deepEqual(Object.keys(e).sort(), [...INDEX_FIELDS].sort());
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "INDEX.json"), "utf8"));
  assert.deepEqual(onDisk, idx);
  assert.equal("history" in onDisk.works[0], false);
  assert.deepEqual(readIndex(dir), idx);
});

test("addAlias: normalized dedup, input→common when attested, stronger kind wins, never deletes, skips title / >80 chars", () => {
  const w = work();
  const base = { origin_job_id: "j1", first_seen: "t1", source_ids: [] as string[] };
  assert.equal(addAlias(w, { ...base, text: " まどマギ ", kind: "input", attested: false }), "added");
  assert.equal(w.aliases[0].text, "まどマギ");
  assert.equal(addAlias(w, { ...base, text: "まどマギ", kind: "input", attested: false, origin_job_id: "j2" }), "unchanged");
  assert.equal(addAlias(w, { ...base, text: "ｍａｄｏｍａｇｉ", kind: "input", attested: false }), "added");
  assert.equal(addAlias(w, { ...base, text: "まどマギ", kind: "input", attested: true, source_ids: ["s9"], origin_job_id: "j3", first_seen: "t3" }), "merged");
  assert.deepEqual(w.aliases[0], { text: "まどマギ", kind: "common", attested: true, source_ids: ["s9"], origin_job_id: "j1", first_seen: "t1" });
  assert.equal(addAlias(w, { ...base, text: "まどマギ", kind: "official_alt", attested: true, source_ids: ["s1"] }), "merged");
  assert.equal(w.aliases[0].kind, "official_alt");
  assert.deepEqual(w.aliases[0].source_ids, ["s1", "s9"]);
  assert.equal(addAlias(w, { ...base, text: "まどマギ", kind: "input", attested: false }), "unchanged", "never downgraded");
  assert.equal(addAlias(w, { ...base, text: "魔法少女まどか☆マギカ", kind: "input", attested: false }), "skipped");
  assert.equal(addAlias(w, { ...base, text: "あ".repeat(81), kind: "input", attested: false }), "skipped");
  assert.equal(addAlias(w, { ...base, text: "a\nb", kind: "input", attested: false }), "added");
  assert.equal(w.aliases.at(-1)!.text, "a b", "one line");
  assert.equal(w.aliases.length, 3);
  assert.equal(addAlias(w, { ...base, text: "新規", kind: "common", attested: true, source_ids: ["s2"] }), "added");
  assert.equal(w.aliases.at(-1)!.kind, "common");
});

// ------------------------------------------------------------------ decision helpers

const card = (id: string, tier: Tier, site_key: string) => ({ source_id: id, tier, site_key }) as SourceCard;

test("decideTitleStatus: T1 ≥1 or T2 ≥2 distinct site_key → confirmed; otherwise provisional", () => {
  const cards = new Map([
    ["t1", card("t1", "T1", "pub.example")],
    ["t2a", card("t2a", "T2", "a.example")],
    ["t2a2", card("t2a2", "T2", "a.example")],
    ["t2b", card("t2b", "T2", "b.example")],
    ["t3", card("t3", "T3", "wikipedia.org")],
    ["t4", card("t4", "T4", "fan.example")],
  ]);
  const ev = (...ids: string[]) => ids.map((source_id) => ({ source_id, offset: 0, length: 1 }));
  assert.equal(decideTitleStatus(ev(), cards), "provisional");
  assert.equal(decideTitleStatus(ev("t4", "t3"), cards), "provisional");
  assert.equal(decideTitleStatus(ev("t1"), cards), "confirmed");
  assert.equal(decideTitleStatus(ev("t2a", "t2a2"), cards), "provisional");
  assert.equal(decideTitleStatus(ev("t2a", "t2b"), cards), "confirmed");
  assert.equal(decideTitleStatus(ev("unknown-card"), cards), "provisional");
});

test("groupCandidates merges by normKey(title)+medium with the earliest year; applyMediumHint narrows only when useful", () => {
  const base: VerifiedCandidate = { title: "X作品", title_original: null, title_reading: null, medium: "novel", creators: ["a"], first_release_year: 2005, evidence: [{ source_id: "s1", offset: 0, length: 3 }], aliases: [] };
  const g = groupCandidates([
    base,
    { ...base, title: "X 作品", title_reading: "えっくす さくひん", creators: ["b"], first_release_year: 2001, evidence: [{ source_id: "s2", offset: 4, length: 3 }] },
    { ...base, medium: "anime", first_release_year: 2010 },
  ]);
  assert.equal(g.length, 2);
  const novel = g.find((c) => c.medium === "novel")!;
  assert.equal(novel.first_release_year, 2001);
  assert.equal(novel.title_reading, "えっくす さくひん");
  assert.deepEqual(novel.creators, ["a", "b"]);
  assert.equal(novel.evidence.length, 2);
  assert.equal(applyMediumHint(g, "anime").list.length, 1);
  assert.equal(applyMediumHint(g, "game").list.length, 2, "hint matching nothing is ignored");
  assert.equal(applyMediumHint(g, null).list.length, 2);
});

test("normalizeReading folds katakana to hiragana; capSearchEvents keeps the first N searches", () => {
  assert.equal(normalizeReading(" マホウ　ショウジョ "), "まほう しょうじょ");
  assert.equal(normalizeReading(""), null);
  const ev = (i: number, action: "search" | "open_page") => ({ itemId: `w${i}`, action, query: null, url: null, results: [] });
  const r = capSearchEvents([ev(1, "search"), ev(2, "open_page"), ev(3, "search"), ev(4, "search")], 2);
  assert.equal(r.observed, 3);
  assert.deepEqual(r.events.map((e) => e.itemId), ["w1", "w2", "w3"]);
});
