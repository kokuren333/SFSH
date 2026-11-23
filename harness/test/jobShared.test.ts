import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSelections, recordSearchCall, urlMatchKey } from "../src/research/candidates.ts";
import { findQuote, hasVerbatimRun, normKey, windows } from "../src/research/textMatch.ts";

test("urlMatchKey: lenient same-page key", () => {
  assert.equal(urlMatchKey("https://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag"), "example.com/a/b?a=1&b=2");
  assert.equal(urlMatchKey("http://example.com/a/b"), "example.com/a/b");
  assert.equal(urlMatchKey("ftp://example.com/"), null);
  assert.equal(urlMatchKey("not a url"), null);
  assert.equal(urlMatchKey("https://ja.wikipedia.org/wiki/%E9%AD%94%E6%B3%95"), "ja.wikipedia.org/wiki/魔法");
});

test("filterSelections: only URLs present in search events survive; self-reported are rejected with a gap", () => {
  const call = recordSearchCall(
    "call1",
    "s1.search",
    "2026-11-23T00:00:00+09:00",
    [
      { itemId: "w1", action: "search", query: "q", url: null, results: [{ url: "https://a.example/p?x=1", title: "A", domain: "a.example", snippet: "" }] },
      { itemId: "w2", action: "open_page", query: null, url: "https://b.example/", results: [] },
    ],
  );
  const r = filterSelections(
    [
      { url: "https://www.a.example/p/?x=1", why: "w", aspects: ["M01"], tier_suggested: "T2" },
      { url: "https://made-up.example/x", why: "memory" },
      { url: "https://instr.example/doc" },
    ],
    call,
    "2026-11-23T00:00:00+09:00",
    [{ url: "https://instr.example/doc", note: "given by requester" }],
  );
  assert.equal(r.selected.length, 2);
  assert.equal(r.selected[0].url, "https://a.example/p?x=1", "event URL string is kept verbatim");
  assert.deepEqual(r.selected[0].origin, { kind: "search_event", callId: "call1", itemId: "w1", query: "q" });
  assert.equal(r.selected[0].tierSuggested, "T2");
  assert.equal(r.selected[1].origin.kind, "instruction");
  assert.deepEqual(r.rejected.map((x) => [x.url, x.reason]), [["https://made-up.example/x", "self_reported"]]);
  assert.deepEqual(r.gaps.map((g) => g.kind).sort(), ["self_reported_url", "unverified_open_page"]);
});

test("findQuote: NFKC + whitespace-insensitive, returns original span", () => {
  const text = "前文。『魔法少女まどか☆マギカ』は、２０１１年に\n放送された。";
  const hit = findQuote(text, "2011年に放送された");
  assert.ok(hit);
  assert.equal(text.slice(hit.offset, hit.offset + hit.length), "２０１１年に\n放送された");
  assert.equal(findQuote(text, "2012年"), null);
  assert.equal(findQuote(text, "年"), null, "1-char quotes never match");
});

test("hasVerbatimRun: 30-char rule", () => {
  const src = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
  const w = windows(normKey(src), 30);
  assert.equal(hasVerbatimRun("前置き" + src.slice(5, 35) + "後置き", w, 30), true);
  assert.equal(hasVerbatimRun("前置き" + src.slice(5, 34) + "後置き", w, 30), false);
});
