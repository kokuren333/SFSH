import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StageContext } from "../src/job/context.ts";
import type { ModelPort, ModelRequest, ModelResult, WebSearchEvent } from "../src/model/types.ts";
import { strictSchemaViolations } from "../src/model/validate.ts";
import { COPIED_TEXT_REDACTED, extractClaims } from "../src/research/claims.ts";
import { reviewClaims } from "../src/research/claimReview.ts";
import type { Claim } from "../src/research/claimTypes.ts";
import { followUp } from "../src/research/followup.ts";
import { CLAIMS_SCHEMA, REPHRASE_SCHEMA } from "../src/research/prompts/claims.ts";
import { OWN_WORDS_RULE } from "../src/research/prompts/common.ts";
import { REVIEW_SCHEMA, REVISE_SCHEMA } from "../src/research/prompts/claimReview.ts";
import { SEARCH_SCHEMA } from "../src/research/prompts/search.ts";
import {
  appendSources,
  readBudget,
  readCandidates,
  readClaims,
  readClaimsReview,
  readFetchLog,
  readGaps,
  readSearchLog,
  readSources,
  writeClaims,
  writeSources,
} from "../src/research/researchIo.ts";
import { assertCardsTraceable, runSearch } from "../src/research/search.ts";
import type { BudgetState, Candidate, Fetcher, SourceCard } from "../src/research/types.ts";

// ---------- fakes ----------

type Reply = { output: unknown; webSearch?: WebSearchEvent[] };
type Handler = (req: ModelRequest) => Reply;

function fakePort(port: "luna" | "haiku", handler: Handler): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    port,
    modelId: `fake-${port}`,
    calls,
    async call(req: ModelRequest): Promise<ModelResult> {
      calls.push(req);
      const r = handler(req);
      return {
        output: r.output,
        modelId: `fake-${port}`,
        reportedModelId: null,
        toolEvents: port === "luna" ? { webSearch: r.webSearch ?? [], otherToolItems: 0, otherToolTypes: [] } : undefined,
        durationMs: 1,
        tokens: {},
      };
    },
  };
}

const noModel: Handler = (req) => {
  throw new Error(`unexpected model call ${req.task}`);
};

const sidFor = (url: string) => "s" + createHash("sha256").update(url).digest("hex").slice(0, 10);

function seedRaw(workDir: string, sid: string, text: string): void {
  mkdirSync(join(workDir, "research", "raw"), { recursive: true });
  writeFileSync(join(workDir, "research", "raw", `${sid}.txt`), text, "utf8");
}

function makeCard(url: string, text: string, origin: Candidate["origin"]): SourceCard {
  const sid = sidFor(url);
  const host = new URL(url).hostname;
  return {
    source_id: sid,
    url,
    final_url: url,
    title: `title of ${host}`,
    publisher: host,
    domain: host,
    site_key: host,
    tier: "T3",
    tier_basis: "default",
    license: null,
    fetched_at: "2026-11-23T00:00:00",
    content_hash: "sha256:" + createHash("sha256").update(text).digest("hex"),
    raw_text_path: `research/raw/${sid}.txt`,
    text_chars: text.length,
    excerpts: [],
    origin,
  };
}

/** Fake WP-1.2 fetcher: writes raw/<sid>.txt, returns cards, respects the fetch budget. */
function fakeFetcher(texts: Record<string, string> = {}): Fetcher & { received: string[] } {
  const received: string[] = [];
  return {
    received,
    async fetchAll(cands, fctx) {
      const cards: SourceCard[] = [];
      const decisions: Awaited<ReturnType<Fetcher["fetchAll"]>>["decisions"] = [];
      const gaps: Awaited<ReturnType<Fetcher["fetchAll"]>>["gaps"] = [];
      for (const c of cands) {
        received.push(c.url);
        const at = "2026-11-23T00:00:00";
        if (fctx.budget.fetchesUsed >= fctx.budget.limits.fetches) {
          decisions.push({ url: c.url, decision: "budget_exceeded", at, origin: c.origin });
          gaps.push({ kind: "fetch_skipped", url: c.url, detail: "budget", at });
          continue;
        }
        fctx.budget.fetchesUsed++;
        const text = texts[c.url] ?? `${c.url} についての解説本文。これはテスト用の十分に長い本文であり、作品の背景と受容について述べている。`;
        const card = makeCard(c.url, text, c.origin);
        seedRaw(fctx.workDir, card.source_id, text);
        cards.push(card);
        decisions.push({ url: c.url, decision: "fetched", status: 200, sourceId: card.source_id, at, origin: c.origin });
      }
      return { cards, decisions, gaps };
    },
  };
}

function makeCtx(o: { luna?: Handler; haiku?: Handler; fetcher?: Fetcher; budget?: Partial<BudgetState> } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "sfsh-research-"));
  const luna = fakePort("luna", o.luna ?? noModel);
  const haiku = fakePort("haiku", o.haiku ?? noModel);
  const fetcher = (o.fetcher ?? fakeFetcher()) as Fetcher & { received: string[] };
  const budget: BudgetState = {
    limits: { searches: 40, fetches: 60, wallMs: 1_800_000 },
    searchesUsed: 0,
    fetchesUsed: 0,
    startedAt: "2026-11-23T00:00:00",
    ...o.budget,
  };
  const logs: string[] = [];
  const ctx: StageContext = {
    jobId: "job-test",
    workDir,
    workId: "test-work",
    range: [],
    luna,
    haiku,
    fetcher,
    budget,
    now: () => new Date("2026-11-23T03:00:00Z"),
    log: (m) => logs.push(m),
  };
  return { ctx, workDir, luna, haiku, fetcher, logs };
}

const WORK = { title: "星の環", creators: ["架空作者"], medium: "novel", first_release: "2019" };

function searchEvent(id: string, query: string, urls: string[]): WebSearchEvent {
  return { itemId: id, action: "search", query, url: null, results: urls.map((u) => ({ url: u, title: `T ${u}`, domain: new URL(u).hostname, snippet: "" })) };
}

function mkClaim(id: string, sid: string, over: Partial<Claim> = {}): Claim {
  return {
    claim_id: id,
    text: `主張 ${id}`,
    source_ids: [sid],
    evidence: [{ source_id: sid, offset: 0, length: 10 }],
    aspects: ["M01"],
    epistemic: "canon",
    phase_hint: "whole",
    spoiler: "none",
    entities: [],
    authored_by: "luna",
    reviewed_by: null,
    review: "pending",
    status: "active",
    drop_reason: null,
    ...over,
  };
}

const SRC_TEXT =
  "『星の環』は2019年に刊行された長編小説である。主人公の灯子は辺境の観測所で働く技師で、兄の失踪をきっかけに環状都市へ向かう。" +
  "旅の途中で出会った密輸業者の朔と協力関係を結ぶが、朔は灯子の兄を裏切った過去を隠していた。物語の終盤で灯子は都市の管理機構が兄を拘束していたことを知る。" +
  "本作は第40回日本SF大賞を受賞し、喪失と赦しを描いた作品として評価された。";

function seedSource(workDir: string, url: string, text: string): SourceCard {
  const card = makeCard(url, text, { kind: "instruction", note: "test" });
  seedRaw(workDir, card.source_id, text);
  appendSources(workDir, [card]);
  return card;
}

// ---------- schemas ----------

test("Luna schemas are OpenAI-strict", () => {
  for (const s of [SEARCH_SCHEMA, CLAIMS_SCHEMA, REPHRASE_SCHEMA, REVISE_SCHEMA, REVIEW_SCHEMA]) {
    assert.deepEqual(strictSchemaViolations(s), []);
  }
});

// ---------- search ----------

test("runSearch: only event URLs reach the fetcher; self-reported URLs and unverified open_page become gaps", async () => {
  const fetcher = fakeFetcher();
  const { ctx, workDir, luna } = makeCtx({
    fetcher,
    luna: (req) => {
      assert.equal(req.task, "s1.search.r1");
      assert.equal(req.tools, "web_search");
      assert.equal(req.jobId, "job-test");
      assert.equal(req.timeoutMs, 600000);
      return {
        output: {
          selections: [
            { url: "https://www.a.example/p1/", why: "official", aspects: ["bibliographic"], tier_suggested: "T1" },
            { url: "https://made-up.example/x", why: "from memory", aspects: ["M12"], tier_suggested: null },
            { url: "https://b.example/p2", why: "encyclopedia", aspects: ["M01"], tier_suggested: "T3" },
          ],
          notes: null,
        },
        webSearch: [
          searchEvent("w1", "星の環 小説", ["https://a.example/p1", "https://b.example/p2"]),
          searchEvent("w2", "星の環 受賞", ["https://c.example/award"]),
          { itemId: "w3", action: "open_page", query: null, url: "https://evil.example/page", results: [] },
        ],
      };
    },
  });
  const r = await runSearch(ctx, { round: 1, aspects: ["bibliographic", "M01", "M12"], work: WORK, supplement: false });
  assert.equal(luna.calls.length, 1);
  const prompt = luna.calls[0].prompt;
  for (const word of ["海賊版", "歌詞", "全文", "字幕", "書き起こし", "T1"]) assert.ok(prompt.includes(word), word);

  assert.deepEqual(fetcher.received, ["https://a.example/p1", "https://b.example/p2"], "event URL strings, never the self-reported one");
  assert.equal(r.metrics.searches, 2);
  assert.equal(r.metrics.results, 3);
  assert.equal(r.metrics.selected, 2);
  assert.equal(r.metrics.rejected_self_reported, 1);
  assert.equal(r.metrics.fetched, 2);
  assert.equal(r.metrics.unverified_open_pages, 1);

  assert.equal(ctx.budget.searchesUsed, 2);
  assert.equal(ctx.budget.fetchesUsed, 2);
  assert.deepEqual(readBudget(workDir), ctx.budget);
  assert.equal(readSearchLog(workDir).length, 1);
  const cand = readCandidates(workDir);
  assert.equal(cand.selected.length, 2);
  assert.deepEqual(cand.rejected.map((x) => [x.url, x.reason]), [["https://made-up.example/x", "self_reported"]]);
  const gapKinds = readGaps(workDir).map((g) => g.kind).sort();
  assert.deepEqual(gapKinds, ["self_reported_url", "unverified_open_page"]);
  assert.equal(readFetchLog(workDir).length, 2);
  assert.equal(readSources(workDir).length, 2);
  assert.deepEqual(assertCardsTraceable(workDir), []);
});

test("assertCardsTraceable: flags cards whose URL is not in search_log results", async () => {
  const { ctx, workDir } = makeCtx({
    luna: () => ({
      output: { selections: [{ url: "https://a.example/p1", why: "", aspects: [], tier_suggested: null }], notes: null },
      webSearch: [searchEvent("w1", "q", ["https://a.example/p1"])],
    }),
  });
  await runSearch(ctx, { round: 1, aspects: ["bibliographic"], work: WORK, supplement: false });
  assert.deepEqual(assertCardsTraceable(workDir), []);
  const callId = readSearchLog(workDir)[0].call_id;
  appendSources(workDir, [
    makeCard("https://sneaky.example/p", "x", { kind: "search_event", callId, itemId: "w1", query: "q" }),
    makeCard("https://ghost.example/p", "x", { kind: "search_event", callId: "nope", itemId: "w9", query: null }),
    makeCard("https://notgiven.example/p", "x", { kind: "instruction", note: "?" }),
  ]);
  const v = assertCardsTraceable(workDir);
  assert.equal(v.length, 3, v.join("\n"));
});

test("runSearch: instruction URLs are candidates even when Luna does not select them, and are traceable", async () => {
  const fetcher = fakeFetcher();
  const { ctx, workDir } = makeCtx({
    fetcher,
    luna: () => ({ output: { selections: [], notes: "nothing" }, webSearch: [searchEvent("w1", "q", [])] }),
  });
  const r = await runSearch(ctx, { round: 1, aspects: ["bibliographic"], work: WORK, instructionUrls: [{ url: "https://instr.example/doc", note: "requester" }], supplement: false });
  assert.deepEqual(fetcher.received, ["https://instr.example/doc"]);
  assert.equal(r.metrics.fetched, 1);
  assert.deepEqual(assertCardsTraceable(workDir), []);
  assert.deepEqual(assertCardsTraceable(workDir, ["https://instr.example/doc"]), []);
  assert.equal(assertCardsTraceable(workDir, []).length, 1);
});

test("runSearch: exhausted budget makes no model call, records a gap, and returns normally", async () => {
  const fetcher = fakeFetcher();
  const { ctx, workDir, luna } = makeCtx({ fetcher, budget: { searchesUsed: 40 } });
  const r = await runSearch(ctx, { round: 1, aspects: ["M01"], work: WORK });
  assert.equal(luna.calls.length, 0);
  assert.equal(fetcher.received.length, 0);
  assert.equal(r.metrics.searches, 0);
  assert.equal(r.metrics.budget_exhausted, 1);
  assert.deepEqual(readGaps(workDir).map((g) => g.kind), ["budget_exhausted"]);
  assert.ok(r.warnings.length > 0);
});

test("runSearch: cap = min(maxSearches, budget left); overrun is a warning, not a stop", async () => {
  const { ctx } = makeCtx({
    budget: { searchesUsed: 38 },
    luna: (req) => {
      assert.ok(req.prompt.includes("最大 2 回"), "cap 2 is in the prompt");
      return {
        output: { selections: [{ url: "https://a.example/p1", why: "", aspects: [], tier_suggested: null }], notes: null },
        webSearch: [searchEvent("w1", "q1", ["https://a.example/p1"]), searchEvent("w2", "q2", []), searchEvent("w3", "q3", [])],
      };
    },
  });
  const r = await runSearch(ctx, { round: 1, aspects: ["M01"], work: WORK, maxSearches: 12, supplement: false });
  assert.equal(r.metrics.search_cap, 2);
  assert.equal(r.metrics.searches, 3);
  assert.equal(ctx.budget.searchesUsed, 41);
  assert.ok(r.warnings.some((w) => w.includes("exceeded the cap")));
  assert.equal(r.metrics.fetched, 1);
});

test("runSearch: fetch budget exhaustion is handled by the fetcher as gaps; job continues", async () => {
  const { ctx, workDir } = makeCtx({
    budget: { fetchesUsed: 59 },
    luna: () => ({
      output: {
        selections: [
          { url: "https://a.example/1", why: "", aspects: [], tier_suggested: null },
          { url: "https://a.example/2", why: "", aspects: [], tier_suggested: null },
        ],
        notes: null,
      },
      webSearch: [searchEvent("w1", "q", ["https://a.example/1", "https://a.example/2"])],
    }),
  });
  const r = await runSearch(ctx, { round: 1, aspects: ["M01"], work: WORK, supplement: false });
  assert.equal(r.metrics.fetched, 1);
  assert.equal(r.metrics.skipped, 1);
  assert.equal(readBudget(workDir)!.fetchesUsed, 60);
  assert.ok(readGaps(workDir).some((g) => g.kind === "fetch_skipped"));
});

test("runSearch: appends across rounds without losing earlier records", async () => {
  let n = 0;
  const { ctx, workDir } = makeCtx({
    luna: () => {
      n++;
      const u = `https://a.example/r${n}`;
      return { output: { selections: [{ url: u, why: "", aspects: [], tier_suggested: null }], notes: null }, webSearch: [searchEvent(`w${n}`, "q", [u])] };
    },
  });
  await runSearch(ctx, { round: 1, aspects: ["M01"], work: WORK, supplement: false });
  await runSearch(ctx, { round: 2, aspects: ["M01"], work: WORK });
  assert.equal(readSearchLog(workDir).length, 2);
  assert.equal(readSources(workDir).length, 2);
  assert.equal(readCandidates(workDir).selected.length, 2);
  assert.deepEqual(assertCardsTraceable(workDir), []);
});

// ---------- claims ----------

test("extractClaims: evidence check, no quote stored, copy rule, unknown source, ids, excerpts", async () => {
  const { ctx, workDir, luna } = makeCtx({
    luna: (req) => {
      assert.equal(req.task, "s1.claims");
      assert.equal(req.tools, "none");
      assert.ok(req.prompt.includes(OWN_WORDS_RULE));
      const sid = /<source id="(s[0-9a-f]+)"/.exec(req.prompt)![1];
      return {
        output: {
          claims: [
            { source_id: sid, text: "灯子は兄がいなくなったことを理由に環状都市を目指して旅立つ。", evidence_quote: "兄の失踪をきっかけに環状都市へ向かう", aspects: ["M03", "M06", "bogus"], epistemic: "canon", phase_hint: "early", spoiler: "none", entities: ["灯子"] },
            { source_id: sid, text: "灯子の兄は死亡している。", evidence_quote: "兄の死をきっかけに", aspects: ["M03"], epistemic: "canon", phase_hint: "early", spoiler: "mid", entities: [] },
            { source_id: sid, text: "旅の途中で出会った密輸業者の朔と協力関係を結ぶが、朔は灯子の兄を裏切った過去を隠していた。", evidence_quote: "密輸業者の朔と協力関係を結ぶ", aspects: ["M01"], epistemic: "canon", phase_hint: "middle", spoiler: "mid", entities: ["朔"] },
            { source_id: "sdeadbeef00", text: "作品は映画化された。", evidence_quote: "映画化", aspects: ["M12"], epistemic: "canon", phase_hint: "whole", spoiler: "none", entities: [] },
            { source_id: sid, text: "この小説は日本SF大賞を受けている。", evidence_quote: "第40回 日本SF大賞を受賞", aspects: ["M12"], epistemic: "canon", phase_hint: "whole", spoiler: "none", entities: [] },
          ],
        },
      };
    },
  });
  const card = seedSource(workDir, "https://a.example/p1", SRC_TEXT);
  writeClaims(workDir, [mkClaim("c0007", "sother00000", { status: "dropped", drop_reason: "evidence_not_found" })]);
  const r = await extractClaims(ctx, { rephrase: false, sourceIds: [card.source_id] });
  assert.equal(luna.calls.length, 1);
  assert.equal(r.metrics.extracted, 5);
  assert.equal(r.metrics.kept, 2);
  assert.equal(r.metrics.dropped_evidence_not_found, 1);
  assert.equal(r.metrics.dropped_copied_phrase, 1);
  assert.equal(r.metrics.dropped_no_source_card, 1);

  const claims = readClaims(workDir);
  assert.equal(claims.length, 6, "earlier claim kept, 5 appended");
  assert.deepEqual(claims.map((c) => c.claim_id), ["c0007", "c0008", "c0009", "c0010", "c0011", "c0012"]);
  const [, kept, notFound, copied, noCard, kept2] = claims;
  assert.equal(kept.status, "active");
  assert.deepEqual(kept.aspects, ["M03", "M06"], "unknown aspects removed");
  assert.equal(kept.authored_by, "luna");
  assert.equal(kept.review, "pending");
  assert.equal(kept.reviewed_by, null);
  assert.equal(SRC_TEXT.slice(kept.evidence[0].offset, kept.evidence[0].offset + kept.evidence[0].length), "兄の失踪をきっかけに環状都市へ向かう");
  assert.equal(kept2.status, "active", "quote matched after whitespace normalization");
  assert.deepEqual([notFound.status, notFound.drop_reason], ["dropped", "evidence_not_found"]);
  assert.deepEqual([copied.status, copied.drop_reason], ["dropped", "copied_phrase"]);
  assert.equal(copied.text, COPIED_TEXT_REDACTED, "copied wording is not persisted");
  assert.deepEqual([noCard.status, noCard.drop_reason, noCard.source_ids], ["dropped", "no_source_card", []]);

  const raw = readFileSync(join(workDir, "research", "claims.json"), "utf8");
  assert.ok(!raw.includes("evidence_quote"));
  for (const q of ["兄の失踪をきっかけに環状都市へ向かう", "兄の死をきっかけに", "密輸業者の朔と協力関係を結ぶ", "第40回"]) {
    assert.ok(!raw.includes(q), `quote text not stored: ${q}`);
  }

  const src = readSources(workDir)[0];
  assert.equal(src.excerpts.length, 2);
  assert.deepEqual(src.excerpts[0], { text: "兄の失踪をきっかけに環状都市へ向かう", offset: kept.evidence[0].offset, claim_ids: ["c0008"] });
  const { excerpts: _a, ...restAfter } = src;
  const { excerpts: _b, ...restBefore } = card;
  assert.deepEqual(restAfter, restBefore, "only excerpts changed on the card");
});

test("extractClaims: a 30-char copy is rephrased once, and dropped if the rewrite still copies", async () => {
  const copyText = "旅の途中で出会った密輸業者の朔と協力関係を結ぶが、朔は灯子の兄を裏切った過去を隠していた。";
  const mk = (sid: string) => ({ source_id: sid, text: copyText, evidence_quote: "密輸業者の朔と協力関係を結ぶ", aspects: ["M01"], epistemic: "canon", phase_hint: "middle", spoiler: "mid", entities: ["朔"] });
  // rewrite OK
  {
    const { ctx, workDir } = makeCtx({
      luna: (req) => {
        if (req.task === "s1.claims") return { output: { claims: [mk(/<source id="(s[0-9a-f]+)"/.exec(req.prompt)![1])] } };
        assert.equal(req.task, "s1.claims.rephrase");
        return { output: { items: [{ key: "0", text: "灯子は道中で朔という密輸人と手を組むが、朔には兄を裏切った経緯がある。" }] } };
      },
    });
    seedSource(workDir, "https://a.example/p1", SRC_TEXT);
    const r = await extractClaims(ctx);
    assert.equal(r.metrics.kept, 1);
    assert.equal(readClaims(workDir)[0].text, "灯子は道中で朔という密輸人と手を組むが、朔には兄を裏切った経緯がある。");
  }
  // rewrite still copies
  {
    const { ctx, workDir } = makeCtx({
      luna: (req) => {
        if (req.task === "s1.claims") return { output: { claims: [mk(/<source id="(s[0-9a-f]+)"/.exec(req.prompt)![1])] } };
        return { output: { items: [{ key: "0", text: "要するに" + copyText }] } };
      },
    });
    seedSource(workDir, "https://a.example/p1", SRC_TEXT);
    const r = await extractClaims(ctx);
    assert.equal(r.metrics.kept, 0);
    assert.equal(readClaims(workDir)[0].drop_reason, "copied_phrase");
  }
});

test("extractClaims: excerpts stay ≤ 400 chars per source; batching ≤ 24000 chars; truncation at 12000", async () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `第${i}節では観測所の技師が新しい装置の調整に取り組み、その結果として都市の灯りの周期が少しずつ変わっていった経緯が記されている。`);
  const longText = sentences.join("") + "あ".repeat(15000);
  const { ctx, workDir, luna } = makeCtx({
    luna: (req) => {
      const sids = [...req.prompt.matchAll(/<source id="(s[0-9a-f]+)"/g)].map((m) => m[1]);
      const out = [];
      for (const sid of sids) {
        for (let i = 0; i < 12; i++) out.push({ source_id: sid, text: `装置調整の影響その${i}`, evidence_quote: sentences[i].slice(0, 70), aspects: ["M08"], epistemic: "canon", phase_hint: "whole", spoiler: "none", entities: [] });
      }
      return { output: { claims: out } };
    },
  });
  const cards = ["https://a.example/1", "https://a.example/2", "https://a.example/3"].map((u) => seedSource(workDir, u, longText));
  const r = await extractClaims(ctx);
  assert.equal(luna.calls.length, 2, "3 × 12000 chars → 2 batches of ≤ 24000");
  // ~3,900 chars of sentences + 15,000 "あ": truncation at 12,000 leaves about 8,100 "あ" per source.
  for (const c of luna.calls) {
    assert.ok(c.prompt.includes("あ".repeat(8000)));
    assert.ok(!c.prompt.includes("あ".repeat(8500)), "source truncated to 12000 chars");
  }
  assert.equal(r.metrics.kept, 36);
  for (const s of readSources(workDir)) {
    const total = s.excerpts.reduce((n, x) => n + x.text.length, 0);
    assert.ok(total <= 400, `excerpts ${total}`);
    assert.ok(s.excerpts.length >= 5);
    for (const x of s.excerpts) assert.equal(longText.slice(x.offset, x.offset + x.text.length), x.text);
  }
  assert.equal(cards.length, 3);
  // second run: nothing new to extract
  const r2 = await extractClaims(ctx);
  assert.equal(r2.metrics.sources, 0);
  assert.equal(luna.calls.length, 2);
});

// ---------- review ----------

function seedReviewWork(workDir: string): string {
  const card = seedSource(workDir, "https://a.example/p1", SRC_TEXT);
  const sid = card.source_id;
  const ev = { source_id: sid, offset: SRC_TEXT.indexOf("兄の失踪"), length: 8 };
  writeClaims(workDir, [
    mkClaim("c0001", sid, { evidence: [ev], text: "灯子は兄を探して旅に出る。" }),
    mkClaim("c0002", sid, { evidence: [ev], text: "灯子は王族の末裔である。" }),
    mkClaim("c0003", sid, { evidence: [ev], text: "灯子は都市を滅ぼそうとする。" }),
    mkClaim("c0004", sid, { evidence: [ev], text: "朔は最後まで灯子を欺く。" }),
    mkClaim("c0005", sid, { evidence: [ev], text: "朔は灯子の兄を裏切った過去がある。" }),
    mkClaim("c0006", sid, { evidence: [ev], text: "管理機構が兄を拘束していた。", epistemic: "fan_theory" }),
    mkClaim("c0007", sid, { evidence: [ev], text: "旅の中で灯子は朔と組む。" }),
    mkClaim("c0008", sid, { evidence: [ev], text: "既に落とした主張", status: "dropped", drop_reason: "copied_phrase" }),
    mkClaim("c0009", sid, { evidence: [ev], text: "既にレビュー済み", review: "agreed", reviewed_by: "haiku" }),
  ]);
  return sid;
}

test("reviewClaims: actions map to agreed / revised / disputed / dropped; missing findings are saved", async () => {
  const { ctx, workDir, haiku, luna } = makeCtx({
    haiku: (req) => {
      assert.equal(req.task, "s1.claims.review");
      assert.equal(req.tools, undefined);
      assert.ok(req.prompt.includes("出典本文の周辺"));
      assert.ok(!req.prompt.includes('id="c0008"') && !req.prompt.includes('id="c0009"'), "only pending active claims");
      const f = (target_id: string | null, type: string) => ({ target_id, type, severity: "medium", evidence: "根拠が合わない", missing_aspect: null, suggested_query: null });
      return {
        output: {
          findings: [
            f("c0002", "unsupported"),
            f("c0003", "overreach"),
            f("c0004", "unsupported"),
            f("c0005", "copied_phrase"),
            f("c0006", "misclassified"),
            f("c0007", "overreach"),
            f("c9999", "unsupported"),
            { target_id: null, type: "missing", severity: "high", evidence: "受賞歴の claim がない", missing_aspect: "M12", suggested_query: "星の環 日本SF大賞" },
          ],
        },
      };
    },
    luna: (req) => {
      assert.equal(req.task, "s1.claims.revise");
      assert.equal(req.tools, "none");
      assert.ok(!req.prompt.includes('id="c0001"'));
      const a = (claim_id: string, action: string, text: string | null = null, epistemic: string | null = null) => ({ claim_id, action, text, epistemic, reason: "r" });
      return {
        output: {
          actions: [
            a("c0002", "drop"),
            a("c0003", "revise", "灯子は都市の管理機構と対立する。"),
            a("c0004", "keep"),
            a("c0005", "keep"),
            a("c0006", "revise", null, "canon"),
            a("c0007", "revise", "旅の途中で出会った密輸業者の朔と協力関係を結ぶが、朔は灯子の兄を裏切った過去を隠していた。"),
          ],
        },
      };
    },
  });
  seedReviewWork(workDir);
  const r = await reviewClaims(ctx, { maxRounds: 1 });
  assert.equal(haiku.calls.length, 1);
  assert.equal(luna.calls.length, 1);
  assert.match(luna.calls[0].prompt, /これは第1回で最後の対応です/);
  const by = new Map(readClaims(workDir).map((c) => [c.claim_id, c]));
  const st = (id: string) => [by.get(id)!.status, by.get(id)!.review, by.get(id)!.drop_reason];
  assert.deepEqual(st("c0001"), ["active", "agreed", null]);
  assert.deepEqual(st("c0002"), ["dropped", "pending", "review_unsupported"]);
  assert.deepEqual(st("c0003"), ["active", "revised", null]);
  assert.equal(by.get("c0003")!.text, "灯子は都市の管理機構と対立する。");
  assert.deepEqual(st("c0004"), ["active", "disputed", null]);
  assert.deepEqual(st("c0005"), ["dropped", "pending", "copied_phrase"], "unresolved copied_phrase is dropped (C-2)");
  assert.equal(by.get("c0005")!.text, COPIED_TEXT_REDACTED);
  assert.deepEqual(st("c0006"), ["active", "revised", null]);
  assert.equal(by.get("c0006")!.epistemic, "canon");
  assert.deepEqual(st("c0007"), ["dropped", "pending", "copied_phrase"], "revised text failing the 30-char rule is dropped");
  assert.equal(by.get("c0007")!.text, "旅の中で灯子は朔と組む。");
  assert.deepEqual(st("c0008"), ["dropped", "pending", "copied_phrase"], "untouched");
  assert.deepEqual(st("c0009"), ["active", "agreed", null], "untouched");
  for (const id of ["c0001", "c0002", "c0003", "c0004", "c0005", "c0006", "c0007"]) assert.equal(by.get(id)!.reviewed_by, "haiku");

  assert.equal(r.metrics.agreed, 1);
  assert.equal(r.metrics.revised, 2);
  assert.equal(r.metrics.disputed, 1);
  assert.equal(r.metrics.dropped, 3);
  assert.equal(r.metrics.missing, 1);
  assert.equal(r.metrics.missing_aspects, "M12");
  assert.ok(r.warnings.some((w) => w.includes("M12") && w.includes("星の環 日本SF大賞")));
  assert.ok(r.warnings.some((w) => w.includes("c9999")));

  const log = readClaimsReview(workDir);
  assert.equal(log.length, 1);
  assert.equal(log[0].round, 1);
  assert.equal(log[0].findings.length, 8);
  assert.equal(log[0].actions.length, 6);
  assert.deepEqual(log[0].missing, [{ aspect: "M12", suggested_query: "星の環 日本SF大賞", note: "受賞歴の claim がない" }]);
  // WP-2.1: unresolved non-copied findings → advisory; copied_phrase drops recorded as deleted
  const entry = log[0] as (typeof log)[number] & { advisory: { target_id: string; type: string }[]; deleted: string[] };
  assert.deepEqual(entry.advisory.map((a) => `${a.target_id}:${a.type}`), ["c0004:unsupported"]);
  assert.deepEqual(entry.deleted.sort(), ["c0005", "c0007"]);
  assert.equal(r.metrics.deleted_copied_phrase, 2);
  assert.equal(r.metrics.advisory, 1);
  assert.ok(!JSON.stringify(readClaims(workDir)).includes("context"));
});

test("reviewClaims: default 2 rounds re-review claims that had findings; a kept finding not re-raised stays unresolved (copied_phrase → dropped at the end)", async () => {
  let round = 0;
  const { ctx, workDir, haiku, luna } = makeCtx({
    haiku: (req) => {
      round++;
      if (round === 1) {
        return { output: { findings: [{ target_id: "c0005", type: "copied_phrase", severity: "high", evidence: "言い回しが近い", missing_aspect: null, suggested_query: null }, { target_id: "c0004", type: "unsupported", severity: "high", evidence: "x", missing_aspect: null, suggested_query: null }] } };
      }
      assert.ok(req.prompt.includes('id="c0005"') && req.prompt.includes('id="c0004"'));
      assert.ok(!req.prompt.includes('id="c0001"'));
      assert.match(req.prompt, /今回は第2回レビューで、これが最後/);
      assert.match(req.prompt, /c0005 第1回 \[copied_phrase\] 言い回しが近い → keep（正しい）/);
      return { output: { findings: [{ target_id: "c0004", type: "unsupported", severity: "high", evidence: "x", missing_aspect: null, suggested_query: null }] } };
    },
    luna: (req) => {
      const ids = [...req.prompt.matchAll(/<claim id="(c\d+)"/g)].map((m) => m[1]);
      return { output: { actions: ids.map((claim_id) => ({ claim_id, action: "keep", text: null, epistemic: null, reason: "正しい" })) } };
    },
  });
  seedReviewWork(workDir);
  const r = await reviewClaims(ctx, { claimIds: ["c0001", "c0004", "c0005"] });
  assert.equal(haiku.calls.length, 2);
  assert.equal(r.metrics.rounds, 2);
  assert.match(luna.calls[0].prompt, /これは第1回の対応です（最大2往復）/);
  assert.match(luna.calls[1].prompt, /これは第2回で最後の対応です/);
  const by = new Map(readClaims(workDir).map((c) => [c.claim_id, c]));
  assert.equal(by.get("c0005")!.status, "dropped", "kept copied_phrase, not re-raised → still unresolved → C-2");
  assert.equal(by.get("c0005")!.drop_reason, "copied_phrase");
  assert.equal(by.get("c0005")!.text, COPIED_TEXT_REDACTED);
  assert.equal(by.get("c0004")!.review, "disputed");
  assert.equal(by.get("c0004")!.status, "active");
  assert.equal(by.get("c0001")!.review, "agreed");
  assert.equal(by.get("c0002")!.review, "pending", "not in claimIds");
  const log = readClaimsReview(workDir) as (ReturnType<typeof readClaimsReview>[number] & { advisory: { target_id: string; round: number }[]; deleted: string[] })[];
  assert.deepEqual(log.map((e) => e.round), [1, 2]);
  assert.deepEqual(log[0].advisory, [], "round-1 disputes are provisional");
  assert.deepEqual(log[1].advisory.map((a) => `${a.target_id}@${a.round}`), ["c0004@2"]);
  assert.deepEqual(log[1].deleted, ["c0005"]);
  // quality metrics merged into the work ledger
  const sum = JSON.parse(readFileSync(join(workDir, "nkg", "review_summary.json"), "utf8"));
  assert.equal(sum.stages[0].stage, "s1.claims");
  assert.equal(sum.stages[0].rounds, 2);
  assert.equal(sum.stages[0].findings, 3);
  assert.equal(sum.stages[0].declined, 3);
  assert.equal(sum.stages[0].deleted, 1);
  assert.equal(sum.stages[0].disputed, 1);
  assert.equal(sum.stages[0].advisory, 1);
});

test("reviewClaims: round 2 re-raise answered with revise resolves; copied_phrase revised away is kept", async () => {
  let round = 0;
  const f = (target_id: string, type: string) => ({ target_id, type, severity: "high", evidence: "e", missing_aspect: null, suggested_query: null });
  const { ctx, workDir } = makeCtx({
    haiku: () => {
      round++;
      return { output: { findings: round === 1 ? [f("c0004", "unsupported"), f("c0005", "copied_phrase"), f("c0006", "misclassified")] : [f("c0004", "unsupported"), f("c0005", "copied_phrase")] } };
    },
    luna: (req) => {
      const ids = [...req.prompt.matchAll(/<claim id="(c\d+)"/g)].map((m) => m[1]);
      const last = req.prompt.includes("最後の対応");
      return {
        output: {
          actions: ids.map((claim_id) =>
            !last
              ? { claim_id, action: "keep", text: null, epistemic: null, reason: "正しい" }
              : claim_id === "c0004"
                ? { claim_id, action: "revise", text: null, epistemic: "fan_theory", reason: "区分を弱めた" }
                : { claim_id, action: "revise", text: "朔には灯子の兄との因縁がある。", epistemic: null, reason: "言い換えた" },
          ),
        },
      };
    },
  });
  seedReviewWork(workDir);
  await reviewClaims(ctx, { claimIds: ["c0004", "c0005", "c0006"] });
  const by = new Map(readClaims(workDir).map((c) => [c.claim_id, c]));
  assert.deepEqual([by.get("c0004")!.status, by.get("c0004")!.review, by.get("c0004")!.epistemic], ["active", "revised", "fan_theory"]);
  assert.deepEqual([by.get("c0005")!.status, by.get("c0005")!.review, by.get("c0005")!.text], ["active", "revised", "朔には灯子の兄との因縁がある。"]);
  assert.deepEqual([by.get("c0006")!.status, by.get("c0006")!.review], ["active", "disputed"], "kept misclassified, not re-raised → disputed (§3.3)");
  const log = readClaimsReview(workDir) as (ReturnType<typeof readClaimsReview>[number] & { advisory: { target_id: string; type: string; round: number }[] })[];
  assert.deepEqual(log[1].advisory.map((a) => `${a.target_id}:${a.type}@${a.round}`), ["c0006:misclassified@1"]);
});

test("reviewClaims: batches of 120 claims per Haiku call", async () => {
  const { ctx, workDir, haiku } = makeCtx({ haiku: () => ({ output: { findings: [] } }) });
  const card = seedSource(workDir, "https://a.example/p1", SRC_TEXT);
  writeClaims(workDir, Array.from({ length: 250 }, (_, i) => mkClaim(`c${String(i + 1).padStart(4, "0")}`, card.source_id)));
  const r = await reviewClaims(ctx);
  assert.equal(haiku.calls.length, 3);
  assert.equal(r.metrics.agreed, 250);
  assert.equal(readClaimsReview(workDir).length, 3);
});

// ---------- follow-up ----------

test("followUp: no-op when nothing is missing", async () => {
  const { ctx, workDir, luna, haiku } = makeCtx();
  const card = seedSource(workDir, "https://a.example/p1", SRC_TEXT);
  const claims: Claim[] = [];
  let n = 1;
  for (const m of ["M01", "M02", "M03", "M06", "M07", "M10", "M12"]) for (let i = 0; i < 3; i++) claims.push(mkClaim(`c${String(n++).padStart(4, "0")}`, card.source_id, { aspects: [m], review: "agreed" }));
  writeClaims(workDir, claims);
  const r = await followUp(ctx, { work: WORK });
  assert.equal(r.metrics.triggered, 0);
  assert.equal(luna.calls.length + haiku.calls.length, 0);
});

test("followUp: Haiku missing aspects + short core modules trigger search r2 → claims for new sources → review of new claims; still-short → gaps", async () => {
  const newUrl = "https://award.example/news";
  const newText = "長編小説『星の環』が第40回日本SF大賞に選ばれた。選考委員は喪失と赦しの主題を高く評価した。";
  const fetcher = fakeFetcher({ [newUrl]: newText });
  const { ctx, workDir, luna, haiku } = makeCtx({
    fetcher,
    luna: (req) => {
      if (req.task === "s1.search.r2") {
        assert.ok(req.prompt.includes("M12"));
        assert.ok(req.prompt.includes("星の環 日本SF大賞"), "suggested query passed as a hint");
        assert.ok(req.prompt.includes("最大 8 回"));
        return { output: { selections: [{ url: newUrl, why: "award", aspects: ["M12"], tier_suggested: "T2" }], notes: null }, webSearch: [searchEvent("w1", "星の環 日本SF大賞", [newUrl])] };
      }
      if (req.task === "s1.claims") {
        const sids = [...req.prompt.matchAll(/<source id="(s[0-9a-f]+)"/g)].map((m) => m[1]);
        assert.deepEqual(sids, [sidFor(newUrl)], "only the new source");
        return {
          output: {
            claims: [
              { source_id: sids[0], text: "本作は日本SF大賞を獲得した。", evidence_quote: "第40回日本SF大賞に選ばれた", aspects: ["M12"], epistemic: "canon", phase_hint: "whole", spoiler: "none", entities: [] },
              { source_id: sids[0], text: "選考では喪失と赦しという主題が評価の中心となった。", evidence_quote: "喪失と赦しの主題を高く評価した", aspects: ["M12", "M10"], epistemic: "consensus", phase_hint: "whole", spoiler: "none", entities: [] },
            ],
          },
        };
      }
      throw new Error(`unexpected ${req.task}`);
    },
    haiku: (req) => {
      const ids = [...req.prompt.matchAll(/<claim id="(c\d+)"/g)].map((m) => m[1]);
      assert.deepEqual(ids, ["c0003", "c0004"], "only the new claims are reviewed");
      return { output: { findings: [] } };
    },
  });
  const old = seedSource(workDir, "https://a.example/p1", SRC_TEXT);
  writeClaims(workDir, [
    mkClaim("c0001", old.source_id, { aspects: ["M12"], review: "agreed" }),
    mkClaim("c0002", old.source_id, { aspects: ["M01"], review: "agreed" }),
  ]);
  const r = await followUp(ctx, { work: WORK, missing: [{ aspect: "M12", suggested_query: "星の環 日本SF大賞", note: "受賞" }] });
  assert.equal(r.metrics.triggered, 1);
  assert.equal(luna.calls.filter((c) => c.task === "s1.search.r2").length, 1);
  assert.equal(haiku.calls.length, 1);
  assert.equal(r.metrics.new_sources, 1);
  assert.equal(r.metrics.new_active_claims, 2);
  const by = new Map(readClaims(workDir).map((c) => [c.claim_id, c]));
  assert.equal(by.get("c0003")!.review, "agreed");
  assert.equal(by.get("c0001")!.review, "agreed");
  // M12 now has 3 → covered; M10 has 1 → still short; M01..M07 short → gaps.
  const gapAspects = readGaps(workDir).filter((g) => g.kind === "no_sources_for_aspect").map((g) => g.aspect).sort();
  assert.deepEqual(gapAspects, ["M01", "M02", "M03", "M06", "M07", "M10"]);
  assert.deepEqual(assertCardsTraceable(workDir).filter((v) => !v.startsWith(old.source_id)), []);
});

test("followUp: reads missing aspects from claims_review.json by default", async () => {
  const { ctx, workDir, luna } = makeCtx({
    luna: (req) => {
      assert.equal(req.task, "s1.search.r2");
      assert.ok(req.prompt.includes("受賞歴"));
      return { output: { selections: [], notes: null }, webSearch: [searchEvent("w1", "q", [])] };
    },
  });
  const card = seedSource(workDir, "https://a.example/p1", SRC_TEXT);
  const claims: Claim[] = [];
  let n = 1;
  for (const m of ["M01", "M02", "M03", "M06", "M07", "M10", "M12"]) for (let i = 0; i < 3; i++) claims.push(mkClaim(`c${String(n++).padStart(4, "0")}`, card.source_id, { aspects: [m] }));
  writeClaims(workDir, claims);
  writeFileSync(
    join(workDir, "research", "claims_review.json"),
    JSON.stringify([{ round: 1, batch: 1, at: "x", claim_ids: [], findings: [], actions: [], outcomes: [], missing: [{ aspect: "受賞歴", suggested_query: null, note: "n" }] }]),
  );
  const r = await followUp(ctx, { work: WORK });
  assert.equal(r.metrics.triggered, 1);
  assert.equal(luna.calls.length, 1);
  assert.deepEqual(readGaps(workDir).filter((g) => g.kind === "no_sources_for_aspect").map((g) => g.aspect), ["受賞歴"]);
});

test("writeSources/readSources round-trip keeps earlier records on append", () => {
  const { workDir } = makeCtx();
  const a = makeCard("https://a.example/1", "x", { kind: "instruction", note: "" });
  const b = makeCard("https://a.example/2", "y", { kind: "instruction", note: "" });
  writeSources(workDir, [a]);
  appendSources(workDir, [b]);
  assert.deepEqual(readSources(workDir).map((c) => c.url), [a.url, b.url]);
});

// ---------- search supplement (CP-029 finding a) ----------

const SUPP_TASK = "s1.search.r1.supplement";
const suppAspect = (prompt: string): string => /## 調べる観点（この1つだけ）\n- (\S+)/.exec(prompt)?.[1] ?? "?";
const pick = (url: string, aspects: string[]) => ({ url, why: "検索結果から", aspects, tier_suggested: null });

test("runSearch supplement: a low search count triggers supplements (least-covered aspects, one aspect per call) even when every aspect is covered", async () => {
  const fetcher = fakeFetcher();
  const { ctx, workDir, luna } = makeCtx({
    fetcher,
    luna: (req) => {
      if (req.task === "s1.search.r1")
        return {
          output: {
            selections: [pick("https://a.example/bib", ["bibliographic"]), pick("https://a.example/m01", ["M01"]), pick("https://a.example/m10a", ["M10"]), pick("https://a.example/m10b", ["M10 テーマ"])],
            notes: null,
          },
          webSearch: [searchEvent("w1", "q1", ["https://a.example/bib", "https://a.example/m01"]), searchEvent("w2", "q2", ["https://a.example/m10a", "https://a.example/m10b"])],
        };
      assert.equal(req.task, SUPP_TASK);
      assert.equal(req.tools, "web_search");
      const a = suppAspect(req.prompt);
      const u = `https://supp.example/${a}`;
      return { output: { selections: [pick(u, [a])], notes: null }, webSearch: [searchEvent(`s-${a}`, `星の環 ${a}`, [u])] };
    },
  });
  const r = await runSearch(ctx, { round: 1, aspects: ["bibliographic", "M01", "M10"], work: WORK });
  // 2 searches < 6 → ceil(4 / 2) = 2 supplement calls; every aspect covered → the least-covered ones (M10 has 2 cards)
  assert.deepEqual(luna.calls.map((c) => c.task), ["s1.search.r1", SUPP_TASK, SUPP_TASK]);
  assert.deepEqual(luna.calls.slice(1).map((c) => suppAspect(c.prompt)), ["bibliographic", "M01"]);
  for (const c of luna.calls.slice(1)) {
    assert.ok(c.prompt.includes("最大 2 回"), "per-call cap in the prompt");
    assert.equal(c.prompt.includes("- M10"), false, "a supplement prompt names one aspect only");
    assert.ok(c.prompt.includes("https://a.example/bib"), "already fetched URLs are listed as avoid");
  }
  assert.equal(r.metrics.searches_main, 2);
  assert.equal(r.metrics.supplement_calls, 2);
  assert.equal(r.metrics.supplement_searches, 2);
  assert.equal(r.metrics.searches, 4);
  assert.equal(ctx.budget.searchesUsed, 4, "budget counts every web_search event");
  assert.equal(r.metrics.aspects_uncovered_before, 0);
  assert.equal(r.metrics.aspects_uncovered_after, 0);
  assert.equal(r.metrics.fetched, 6);
  const log = readSearchLog(workDir) as (ReturnType<typeof readSearchLog>[number] & { supplement?: boolean; aspect?: string })[];
  assert.deepEqual(log.map((x) => [x.task, x.supplement ?? false, x.aspect ?? null]), [
    ["s1.search.r1", false, null],
    [SUPP_TASK, true, "bibliographic"],
    [SUPP_TASK, true, "M01"],
  ]);
  assert.equal(new Set(log.map((x) => x.call_id)).size, 3, "distinct call ids");
  assert.deepEqual(assertCardsTraceable(workDir), []);
});

test("runSearch supplement: one call per uncovered aspect in the given order, max 4 calls; candidates only from the call's events; a failing supplement is a warning", async () => {
  const fetcher = fakeFetcher();
  const { ctx, workDir, luna } = makeCtx({
    fetcher,
    luna: (req) => {
      if (req.task === "s1.search.r1")
        return {
          output: { selections: [pick("https://a.example/p1", ["bibliographic", "M01"])], notes: null },
          // 6 searches: the count alone would not trigger; uncovered aspects do
          webSearch: [1, 2, 3, 4, 5, 6].map((n) => searchEvent(`w${n}`, `q${n}`, n === 1 ? ["https://a.example/p1"] : [])),
        };
      const a = suppAspect(req.prompt);
      switch (a) {
        case "M02":
          return {
            output: { selections: [pick("https://e.example/m02", ["M02"]), pick("https://made-up.example/m02", ["M02"])], notes: null },
            webSearch: [searchEvent("s1", "結末 理由", ["https://e.example/m02"])],
          };
        case "M03":
          throw new Error("codex exited 1");
        case "M06":
          return {
            output: { selections: [pick("https://a.example/p1", ["M06"]), pick("https://e.example/m06", ["M06"])], notes: null },
            webSearch: [searchEvent("s3", "動機", ["https://a.example/p1", "https://e.example/m06"])],
          };
        case "M10":
          return { output: { selections: [], notes: "見つからない" }, webSearch: [searchEvent("s4", "テーマ", [])] };
        default:
          throw new Error(`unexpected supplement aspect ${a}`);
      }
    },
  });
  const aspects = ["bibliographic", "M01", "M02", "M03", "M06", "M10", "M12"];
  const r = await runSearch(ctx, { round: 1, aspects, work: WORK });
  assert.deepEqual(luna.calls.slice(1).map((c) => [c.task, suppAspect(c.prompt)]), [
    [SUPP_TASK, "M02"],
    [SUPP_TASK, "M03"],
    [SUPP_TASK, "M06"],
    [SUPP_TASK, "M10"],
  ], "uncovered aspects in the given order, capped at 4 (M12 not called)");
  // only event URLs reach the fetcher; the already fetched a.example/p1 is not fetched again
  assert.deepEqual(fetcher.received, ["https://a.example/p1", "https://e.example/m02", "https://e.example/m06"]);
  const cand = readCandidates(workDir);
  assert.ok(cand.rejected.some((x) => x.url === "https://made-up.example/m02" && x.reason === "self_reported"));
  assert.ok(readGaps(workDir).some((g) => g.kind === "self_reported_url" && g.url === "https://made-up.example/m02"));
  assert.deepEqual(assertCardsTraceable(workDir), []);
  const cards = readSources(workDir);
  const log = readSearchLog(workDir) as (ReturnType<typeof readSearchLog>[number] & { supplement?: boolean; aspect?: string })[];
  for (const c of cards.filter((x) => x.url.startsWith("https://e.example/"))) {
    const rec = log.find((x) => c.origin.kind === "search_event" && x.call_id === c.origin.callId)!;
    assert.equal(rec.supplement, true);
    assert.equal(`https://e.example/${rec.aspect!.toLowerCase()}`, c.url, "card traces to the supplement call of its aspect");
  }
  assert.deepEqual(log.filter((x) => x.supplement).map((x) => x.aspect), ["M02", "M06", "M10"], "the failed call has no search record");
  // failure → warning, the stage still returns; later supplements still ran
  assert.ok(r.warnings.some((w) => w.includes(`${SUPP_TASK} [M03]: supplement call failed`)));
  assert.equal(r.metrics.supplement_calls, 4);
  assert.equal(r.metrics.supplement_failed_calls, 1);
  assert.equal(r.metrics.supplement_searches, 3);
  assert.equal(ctx.budget.searchesUsed, 9);
  assert.equal(r.metrics.aspects_uncovered_before, 5);
  assert.equal(r.metrics.aspects_uncovered_after, 3);
  assert.equal(r.metrics.aspects_uncovered_list, "M03,M10,M12");
});

test("runSearch supplement: stays within the job search budget (minus the follow-up reserve); skipped aspects become a gap", async () => {
  const { ctx, workDir, luna } = makeCtx({
    budget: { searchesUsed: 30 },
    luna: (req) => {
      if (req.task === "s1.search.r1") return { output: { selections: [], notes: null }, webSearch: [searchEvent("w1", "q", [])] };
      assert.ok(req.prompt.includes("最大 1 回"), "cap = min(2, 40 - 31 - 8)");
      // the model overshoots its cap: counted from the events, then no further supplement call
      return { output: { selections: [], notes: null }, webSearch: [searchEvent("s1", "a", []), searchEvent("s2", "b", [])] };
    },
  });
  const r = await runSearch(ctx, { round: 1, aspects: ["M01", "M02", "M03", "M10"], work: WORK });
  assert.equal(luna.calls.filter((c) => c.task === SUPP_TASK).length, 1);
  assert.equal(ctx.budget.searchesUsed, 33);
  assert.equal(r.metrics.supplement_calls, 1);
  const g = readGaps(workDir).find((x) => x.kind === "budget_exhausted");
  assert.ok(g && g.detail.includes("M02, M03, M10"), String(g?.detail));
  assert.ok(r.warnings.some((w) => w.includes("search supplement skipped")));

  // no budget left beyond the reserve → no supplement call at all
  const z = makeCtx({ budget: { searchesUsed: 31 }, luna: () => ({ output: { selections: [], notes: null }, webSearch: [searchEvent("w1", "q", [])] }) });
  const r2 = await runSearch(z.ctx, { round: 1, aspects: ["M01"], work: WORK });
  assert.equal(z.luna.calls.length, 1);
  assert.equal(r2.metrics.supplement_calls, 0);
  assert.equal(z.ctx.budget.searchesUsed, 32);
});

test("runSearch supplement: off by default after round 1 and when disabled", async () => {
  const reply = () => ({ output: { selections: [], notes: null }, webSearch: [searchEvent("w1", "q", [])] });
  const a = makeCtx({ luna: reply });
  const r2 = await runSearch(a.ctx, { round: 2, aspects: ["M01", "M10"], work: WORK });
  assert.equal(a.luna.calls.length, 1);
  assert.equal(r2.metrics.supplement_enabled, 0);
  assert.equal(r2.metrics.aspects_uncovered_before, 2);
  const b = makeCtx({ luna: reply });
  await runSearch(b.ctx, { round: 1, aspects: ["M01", "M10"], work: WORK, supplement: false });
  assert.equal(b.luna.calls.length, 1);
  const c = makeCtx({ luna: reply });
  const r3 = await runSearch(c.ctx, { round: 2, aspects: ["M01"], work: WORK, supplement: { enabled: true, reserveSearches: 0 } });
  assert.deepEqual(c.luna.calls.map((x) => x.task), ["s1.search.r2", "s1.search.r2.supplement"]);
  assert.equal(r3.metrics.supplement_calls, 1);
});
