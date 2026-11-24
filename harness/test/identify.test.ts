import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModelPort, ModelRequest, ModelResult, WebSearchEvent } from "../src/model/types.ts";
import { strictSchemaViolations, validateAgainst } from "../src/model/validate.ts";
import { identify, type IdentifyDeps } from "../src/research/identify/index.ts";
import type { ExtractedCandidate } from "../src/research/identify/prompts.ts";
import type { BudgetState, Candidate, FetchBatchResult, FetchContext, FetchDecision, Fetcher, ResearchGap, SourceCard, Tier } from "../src/research/types.ts";
import { sha256Hex } from "../src/util/hash.ts";
import { readWork } from "../src/works/store.ts";
import type { Work, WorksIndex } from "../src/works/types.ts";

// ------------------------------------------------------------------ fakes

interface Page {
  text: string;
  tier: Tier;
  site_key: string;
  title?: string;
}

const sidOf = (url: string) => "s" + sha256Hex(url).slice(0, 10);

class FakeFetcher implements Fetcher {
  requested: string[] = [];
  private pages: Record<string, Page>;
  constructor(pages: Record<string, Page>) {
    this.pages = pages;
  }
  async fetchAll(candidates: Candidate[], ctx: FetchContext): Promise<FetchBatchResult> {
    const cards: SourceCard[] = [];
    const decisions: FetchDecision[] = [];
    const gaps: ResearchGap[] = [];
    const at = "2026-11-23T10:00:00+09:00";
    for (const c of candidates) {
      if (ctx.budget.fetchesUsed >= ctx.budget.limits.fetches) {
        decisions.push({ url: c.url, decision: "budget_exceeded", at, origin: c.origin });
        gaps.push({ kind: "fetch_skipped", url: c.url, detail: "budget", at });
        continue;
      }
      this.requested.push(c.url);
      ctx.budget.fetchesUsed++;
      const p = this.pages[c.url];
      if (!p) {
        decisions.push({ url: c.url, decision: "http_error", status: 404, at, origin: c.origin });
        gaps.push({ kind: "fetch_skipped", url: c.url, detail: "404", at });
        continue;
      }
      const sid = sidOf(c.url);
      const rel = `research/raw/${sid}.txt`;
      fs.mkdirSync(path.join(ctx.workDir, "research", "raw"), { recursive: true });
      fs.writeFileSync(path.join(ctx.workDir, rel), p.text, "utf8");
      const host = new URL(c.url).hostname;
      cards.push({
        source_id: sid,
        url: c.url,
        final_url: c.url,
        title: p.title ?? host,
        publisher: host,
        domain: host,
        site_key: p.site_key,
        tier: p.tier,
        tier_basis: "table",
        license: null,
        fetched_at: at,
        content_hash: "sha256:" + sha256Hex(p.text),
        raw_text_path: rel,
        text_chars: p.text.length,
        excerpts: [],
        origin: c.origin,
      });
      decisions.push({ url: c.url, decision: "fetched", status: 200, sourceId: sid, at, origin: c.origin });
    }
    return { cards, decisions, gaps };
  }
}

interface Script {
  /** URLs that appear in search results (one search event each unless `searchEvents` given). */
  results?: string[];
  searchEvents?: WebSearchEvent[];
  /** URLs Luna selects (may include self-reported ones). Defaults to `results`. */
  selections?: string[];
  candidates: ExtractedCandidate[];
}

function fakeLuna(script: Script): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    port: "luna",
    modelId: "fake-luna",
    calls,
    async call(req: ModelRequest): Promise<ModelResult> {
      calls.push(req);
      assert.deepEqual(strictSchemaViolations(req.schema), [], `${req.task}: schema must be OpenAI-strict`);
      let output: unknown;
      let webSearch: WebSearchEvent[] = [];
      if (req.task === "s0.identify.search") {
        assert.equal(req.tools, "web_search");
        const results = script.results ?? [];
        webSearch =
          script.searchEvents ??
          [{ itemId: "ws1", action: "search", query: "q", url: null, results: results.map((u) => ({ url: u, title: u, domain: new URL(u).hostname, snippet: "" })) }];
        output = { selections: (script.selections ?? results).map((u) => ({ url: u, why: "bibliographic", tier_suggested: null })) };
      } else if (req.task === "s0.identify.extract") {
        assert.equal(req.tools, "none");
        output = { candidates: script.candidates };
      } else throw new Error(`unexpected task ${req.task}`);
      const v = validateAgainst(req.schema, output);
      assert.ok(v.ok, `${req.task}: output must satisfy schema: ${JSON.stringify(v)}`);
      return { output, modelId: "fake-luna", reportedModelId: null, toolEvents: { webSearch, otherToolItems: 0, otherToolTypes: [] }, durationMs: 1, tokens: {} };
    },
  };
}

function tmpWorks(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-identify-"));
}

function freshBudget(over: Partial<BudgetState> = {}): BudgetState {
  return { limits: { searches: 40, fetches: 60, wallMs: 30 * 60_000 }, searchesUsed: 0, fetchesUsed: 0, startedAt: "2026-11-23T10:00:00+09:00", ...over };
}

function deps(worksDir: string, luna: ModelPort, fetcher: Fetcher, budget = freshBudget()): IdentifyDeps & { logs: string[] } {
  const logs: string[] = [];
  return { luna, fetcher, worksDir, budget, now: () => new Date("2026-11-23T10:00:00+09:00"), log: (m) => logs.push(m), logs };
}

const readIndexFile = (worksDir: string) => JSON.parse(fs.readFileSync(path.join(worksDir, "INDEX.json"), "utf8")) as WorksIndex;
const stagingDirs = (worksDir: string) => fs.readdirSync(worksDir).filter((d) => d.startsWith("_staging-"));

// ------------------------------------------------------------------ Madoka fixture

const TITLE = "魔法少女まどか☆マギカ";
const WID = "anime-mahoushoujo-madoka-magika-2011";
const U_OFFICIAL = "https://www.madoka-magica.com/tv/";
const U_WIKI = "https://ja.wikipedia.org/wiki/madoka";
const U_NEWS = "https://news.example.jp/anime/madoka-2011";
const U_FAKE = "https://made-up.example/madoka";

const PAGES: Record<string, Page> = {
  [U_OFFICIAL]: {
    tier: "T1",
    site_key: "madoka-magika.com",
    text: "TVアニメ『魔法少女まどか☆マギカ』公式サイト\n2011年1月より放送開始。\n原作：Magica Quartet　監督：新房昭之　アニメーション制作：シャフト",
  },
  [U_WIKI]: {
    tier: "T3",
    site_key: "wikipedia.org",
    text: "『魔法少女まどか☆マギカ』（まほうしょうじょまどかまぎか）は、2011年に放送された日本のテレビアニメ作品。\n略称は「まどマギ」。「まどか☆マギカ」とも表記される。",
  },
  [U_NEWS]: {
    tier: "T2",
    site_key: "example.jp",
    text: "話題のオリジナルアニメ「魔法少女まどか☆マギカ」が完結。ファンの間では「まどマギ」の愛称で親しまれている。",
  },
};

function madokaCandidate(opts: { sources?: string[]; aliasesSeen?: boolean } = {}): ExtractedCandidate {
  const sources = opts.sources ?? [U_OFFICIAL, U_WIKI];
  const quotes: Record<string, string> = {
    [U_OFFICIAL]: "TVアニメ『魔法少女まどか☆マギカ』公式サイト",
    [U_WIKI]: "『魔法少女まどか☆マギカ』（まほうしょうじょまどかまぎか）",
    [U_NEWS]: "オリジナルアニメ「魔法少女まどか☆マギカ」が完結",
  };
  return {
    title: TITLE,
    title_original: null,
    title_reading: "まほうしょうじょ まどか まぎか",
    medium: "anime",
    creators: ["Magica Quartet", "新房昭之"],
    first_release_year: 2011,
    evidence: sources.map((u) => ({ source_id: sidOf(u), quote: quotes[u] })),
    aliases_seen: opts.aliasesSeen ? [{ text: "まどマギ", kind: "common", source_id: sidOf(U_WIKI), quote: "略称は「まどマギ」" }] : [],
  };
}

function madokaRun(worksDir: string, query: string, jobId: string, opts: { sources?: string[]; aliasesSeen?: boolean; pages?: Record<string, Page> } = {}) {
  const sources = opts.sources ?? [U_OFFICIAL, U_WIKI];
  const luna = fakeLuna({ results: sources, selections: [...sources, U_FAKE], candidates: [madokaCandidate({ sources, aliasesSeen: opts.aliasesSeen })] });
  const fetcher = new FakeFetcher(opts.pages ?? PAGES);
  const d = deps(worksDir, luna, fetcher);
  return { luna, fetcher, d, run: () => identify({ jobId, workQuery: query, mediumHint: null }, d) };
}

function assertTitleBacked(worksDir: string, work: Work) {
  assert.equal(work.title, TITLE);
  assert.ok(work.title_source_ids.length > 0, "title has source ids");
  const cards = JSON.parse(fs.readFileSync(path.join(worksDir, work.work_id, "research", "sources.json"), "utf8")) as SourceCard[];
  for (const id of work.title_source_ids) {
    const card = cards.find((c) => c.source_id === id);
    assert.ok(card, `title source ${id} has a source card`);
    const raw = fs.readFileSync(path.join(worksDir, work.work_id, card.raw_text_path), "utf8");
    assert.ok(raw.includes(TITLE), `source ${id} text contains the title`);
  }
}

// ------------------------------------------------------------------ gate: three input types

test("gate: 略称 / 通称 / 打ち間違い each resolve to the canonical title with sources; input kept as alias", async () => {
  const cases: { q: string; kind: string; attested: boolean; prefill: boolean }[] = [
    { q: "まどマギ", kind: "common", attested: true, prefill: false },
    { q: "まどか☆マギカ", kind: "common", attested: true, prefill: false },
    { q: "魔法少女まどか★マギカ", kind: "input", attested: false, prefill: true },
  ];
  for (const c of cases) {
    const worksDir = tmpWorks();
    if (c.prefill) {
      // partly filled works dir: an unrelated existing work
      const other: Work = {
        work_id: "novel-hashire-merosu-1940", title: "走れメロス", title_original: null, title_reading: "はしれ めろす", title_reading_basis: "source",
        title_status: "confirmed", title_source_ids: ["sabc"], aliases: [], medium: "novel", creators: ["太宰治"], genres: [], tags: [],
        first_release_year: 1940, publish_mode: "Public", history: [], first_published_at: null, updated_at: null, created_at: "2026-11-01T00:00:00+09:00",
      };
      fs.mkdirSync(path.join(worksDir, other.work_id), { recursive: true });
      fs.writeFileSync(path.join(worksDir, other.work_id, "work.json"), JSON.stringify(other));
    }
    const { run, luna } = madokaRun(worksDir, c.q, `job-${c.kind}-${c.prefill}`);
    const r = await run();
    assert.equal(r.status, "resolved", c.q);
    assert.equal(r.resolved!.work_id, WID);
    assert.equal(r.resolved!.method, "research");
    assert.equal(r.resolved!.title, TITLE);
    assert.equal(r.resolved!.title_status, "confirmed");
    assert.equal(r.resolved!.alias_recorded, true);
    assert.equal(r.notice, `入力「${c.q}」→ 正式名称「${TITLE}」`);
    assert.equal(luna.calls.length, 2);
    const work = readWork(path.join(worksDir, WID));
    assertTitleBacked(worksDir, work);
    assert.equal(work.title_reading, "まほうしょうじょ まどか まぎか");
    assert.equal(work.title_reading_basis, "source");
    assert.equal(work.medium, "anime");
    assert.equal(work.first_release_year, 2011);
    assert.equal(work.publish_mode, "Public");
    const alias = work.aliases.find((a) => a.text === c.q);
    assert.ok(alias, `alias ${c.q} recorded`);
    assert.equal(alias.kind, c.kind, c.q);
    assert.equal(alias.attested, c.attested, c.q);
    assert.equal(alias.origin_job_id, `job-${c.kind}-${c.prefill}`);
    if (c.attested) assert.deepEqual(alias.source_ids, [sidOf(U_WIKI)]);
    else assert.deepEqual(alias.source_ids, []);
    assert.deepEqual(stagingDirs(worksDir), [], "staging dir moved");
    const idx = readIndexFile(worksDir);
    assert.ok(idx.works.some((e) => e.work_id === WID && e.aliases.some((a) => a.text === c.q)));
    assert.equal(idx.works.length, c.prefill ? 2 : 1);
  }
});

test("substring of the title alone does not attest an alias (まどか☆マギカ only inside the full title → input)", async () => {
  const worksDir = tmpWorks();
  const pages = { ...PAGES, [U_WIKI]: { ...PAGES[U_WIKI], text: "『魔法少女まどか☆マギカ』（まほうしょうじょまどかまぎか）は2011年のアニメ。" } };
  const { run } = madokaRun(worksDir, "まどか☆マギカ", "job-sub", { pages });
  const r = await run();
  assert.equal(r.status, "resolved");
  const a = readWork(path.join(worksDir, WID)).aliases.find((x) => x.text === "まどか☆マギカ")!;
  assert.equal(a.kind, "input");
  assert.equal(a.attested, false);
});

// ------------------------------------------------------------------ gate: merge on re-submission

test("gate: re-submission with another notation merges into the existing work_id (research path, then index path)", async () => {
  const worksDir = tmpWorks();
  // 1st: 通称 creates the work (only T1 + wiki)
  const first = madokaRun(worksDir, "まどか☆マギカ", "job-1");
  const r1 = await first.run();
  assert.equal(r1.resolved!.work_id, WID);
  const w1 = readWork(path.join(worksDir, WID));
  assert.ok(!w1.aliases.some((a) => a.text === "まどマギ"), "まどマギ not yet an alias");

  // 2nd: 略称, not in INDEX → research; new source (news) → merges into WID
  const second = madokaRun(worksDir, "まどマギ", "job-2", { sources: [U_OFFICIAL, U_NEWS] });
  const r2 = await second.run();
  assert.equal(r2.status, "resolved");
  assert.equal(r2.resolved!.method, "research");
  assert.equal(r2.resolved!.work_id, WID);
  assert.equal(r2.metrics.merged, "yes");
  const w2 = readWork(path.join(worksDir, WID));
  assert.equal(w2.title, TITLE);
  assert.equal(w2.created_at, w1.created_at);
  assert.ok(w2.history.some((h) => h.event === "merged" && h.job_id === "job-2"));
  const cards = JSON.parse(fs.readFileSync(path.join(worksDir, WID, "research", "sources.json"), "utf8")) as SourceCard[];
  assert.deepEqual(cards.map((c) => c.source_id).sort(), [U_OFFICIAL, U_WIKI, U_NEWS].map(sidOf).sort(), "sources deduped by source_id");
  for (const c of cards) assert.ok(fs.existsSync(path.join(worksDir, WID, c.raw_text_path)), "raw moved");
  assert.deepEqual(w2.title_source_ids, [U_OFFICIAL, U_WIKI, U_NEWS].map(sidOf).sort());
  const alias = w2.aliases.find((a) => a.text === "まどマギ")!;
  assert.equal(alias.kind, "common");
  assert.equal(alias.attested, true);
  assert.ok(w2.aliases.some((a) => a.text === "まどか☆マギカ"));
  const searchLog = JSON.parse(fs.readFileSync(path.join(worksDir, WID, "research", "search_log.json"), "utf8")) as unknown[];
  assert.equal(searchLog.length, 2, "search logs appended");
  assert.deepEqual(stagingDirs(worksDir), []);
  assert.equal(readIndexFile(worksDir).works.length, 1);

  // 3rd: same 略称 again (with NFKC / whitespace noise) → index_match, zero model calls, zero fetches
  const luna3 = fakeLuna({ candidates: [] });
  const fetcher3 = new FakeFetcher(PAGES);
  const d3 = deps(worksDir, luna3, fetcher3);
  const r3 = await identify({ jobId: "job-3", workQuery: "　まどマギ ", mediumHint: null }, d3);
  assert.equal(r3.status, "resolved");
  assert.equal(r3.resolved!.method, "index_match");
  assert.equal(r3.resolved!.work_id, WID);
  assert.equal(r3.resolved!.alias_recorded, true);
  assert.equal(r3.resolved!.title_status, "confirmed");
  assert.deepEqual(r3.resolved!.source_ids, w2.title_source_ids);
  assert.equal(luna3.calls.length, 0);
  assert.equal(fetcher3.requested.length, 0);
  assert.equal(d3.budget.searchesUsed, 0);
  assert.equal(d3.budget.fetchesUsed, 0);
  assert.deepEqual(stagingDirs(worksDir), []);

  // 4th: a new notation that is the reading (index field title_reading) → index_match and recorded as alias
  const luna4 = fakeLuna({ candidates: [] });
  const r4 = await identify({ jobId: "job-4", workQuery: "まほうしょうじょ まどか まぎか", mediumHint: null }, deps(worksDir, luna4, new FakeFetcher(PAGES)));
  assert.equal(r4.resolved!.method, "index_match");
  assert.equal(luna4.calls.length, 0);
  const w4 = readWork(path.join(worksDir, WID));
  const a4 = w4.aliases.find((a) => a.text === "まほうしょうじょ まどか まぎか")!;
  assert.equal(a4.kind, "common", "the reading appears in the saved wiki text → attested");
  assert.ok(w4.history.some((h) => h.event === "alias_added" && h.job_id === "job-4"));
});

test("index path: an input alias becomes attested when the work's saved sources name it", async () => {
  const worksDir = tmpWorks();
  await madokaRun(worksDir, TITLE, "job-a").run();
  const w = readWork(path.join(worksDir, WID));
  assert.equal(w.aliases.length, 0, "input equal to title is not an alias");
  // inject a pre-existing input alias that the saved wiki text attests
  w.aliases.push({ text: "まどマギ", kind: "input", attested: false, source_ids: [], origin_job_id: "old", first_seen: "2026-11-01T00:00:00+09:00" });
  fs.writeFileSync(path.join(worksDir, WID, "work.json"), JSON.stringify(w));
  fs.rmSync(path.join(worksDir, "INDEX.json"));
  const luna = fakeLuna({ candidates: [] });
  const r = await identify({ jobId: "job-b", workQuery: "まどマギ", mediumHint: null }, deps(worksDir, luna, new FakeFetcher(PAGES)));
  assert.equal(r.resolved!.method, "index_match");
  const a = readWork(path.join(worksDir, WID)).aliases.find((x) => x.text === "まどマギ")!;
  assert.equal(a.kind, "common");
  assert.equal(a.attested, true);
  assert.equal(a.origin_job_id, "old", "first origin kept");
});

// ------------------------------------------------------------------ gate: no confirmed without sources

async function statusFor(pages: Record<string, Page>, quotesOk = true) {
  const worksDir = tmpWorks();
  const urls = Object.keys(pages);
  const cand: ExtractedCandidate = {
    title: "テスト作品",
    title_original: null,
    title_reading: "てすと さくひん",
    medium: "novel",
    creators: [],
    first_release_year: 2001,
    evidence: urls.map((u) => ({ source_id: sidOf(u), quote: quotesOk ? "『テスト作品』は" : "『テスト作品』という記憶" })),
    aliases_seen: [],
  };
  const luna = fakeLuna({ results: urls, candidates: [cand] });
  const r = await identify({ jobId: "job-st", workQuery: "テスト作品", mediumHint: null }, deps(worksDir, luna, new FakeFetcher(pages)));
  return { r, worksDir };
}
const page = (tier: Tier, site_key: string): Page => ({ tier, site_key, text: "『テスト作品』は2001年刊行の小説。" });

test("gate: a title without verified sources is never confirmed", async () => {
  // quote not present in any fetched text → candidate dropped → clarifying, no work
  const none = await statusFor({ "https://pub.example/a": page("T1", "pub.example") }, false);
  assert.equal(none.r.status, "clarifying");
  assert.equal(none.r.reason, "no_candidates");
  assert.equal(none.r.metrics.candidates_dropped, 1);
  assert.equal(readIndexFile(none.worksDir).works.length, 0);
  assert.ok(!fs.existsSync(path.join(none.worksDir, "novel-tesuto-sakuhin-2001")));

  const t4 = await statusFor({ "https://fan.example/a": page("T4", "fan.example") });
  assert.equal(t4.r.resolved!.title_status, "provisional");
  assert.equal(readWork(path.join(t4.worksDir, "novel-tesuto-sakuhin-2001")).title_status, "provisional");

  const t1 = await statusFor({ "https://pub.example/a": page("T1", "pub.example") });
  assert.equal(t1.r.resolved!.title_status, "confirmed");

  const t2same = await statusFor({ "https://news.example/a": page("T2", "news.example"), "https://sub.news.example/b": page("T2", "news.example") });
  assert.equal(t2same.r.resolved!.title_status, "provisional");

  const t2diff = await statusFor({ "https://news.example/a": page("T2", "news.example"), "https://paper.example/b": page("T2", "paper.example") });
  assert.equal(t2diff.r.resolved!.title_status, "confirmed");
});

test("evidence must cite a fetched source and contain the title (memory-only / off-title quotes are dropped)", async () => {
  const worksDir = tmpWorks();
  const u = "https://pub.example/a";
  const cand: ExtractedCandidate = {
    title: "テスト作品", title_original: null, title_reading: "てすと さくひん", medium: "novel", creators: [], first_release_year: 2001,
    evidence: [
      { source_id: "s0000000000", quote: "『テスト作品』は" }, // no such card
      { source_id: sidOf(u), quote: "2001年刊行の小説" }, // found, but does not contain the title
    ],
    aliases_seen: [],
  };
  const r = await identify({ jobId: "j", workQuery: "テスト", mediumHint: null }, deps(worksDir, fakeLuna({ results: [u], candidates: [cand] }), new FakeFetcher({ [u]: page("T1", "pub.example") })));
  assert.equal(r.status, "clarifying");
  assert.equal(r.reason, "no_candidates");
  assert.equal(r.metrics.evidence_dropped, 2);
});

test("provisional title is upgraded to confirmed when later evidence meets the rule (merge)", async () => {
  const worksDir = tmpWorks();
  const fan = "https://fan.example/a";
  const pub = "https://pub.example/a";
  const pages = { [fan]: page("T4", "fan.example"), [pub]: page("T1", "pub.example") };
  const mk = (u: string): ExtractedCandidate => ({
    title: "テスト作品", title_original: null, title_reading: "てすと さくひん", medium: "novel", creators: [], first_release_year: 2001,
    evidence: [{ source_id: sidOf(u), quote: "『テスト作品』は" }], aliases_seen: [],
  });
  const r1 = await identify({ jobId: "j1", workQuery: "テスト作品", mediumHint: null }, deps(worksDir, fakeLuna({ results: [fan], candidates: [mk(fan)] }), new FakeFetcher(pages)));
  assert.equal(r1.resolved!.title_status, "provisional");
  const r2 = await identify({ jobId: "j2", workQuery: "てすと作品", mediumHint: null }, deps(worksDir, fakeLuna({ results: [pub], candidates: [mk(pub)] }), new FakeFetcher(pages)));
  assert.equal(r2.resolved!.work_id, r1.resolved!.work_id);
  assert.equal(r2.resolved!.title_status, "confirmed");
  const w = readWork(path.join(worksDir, r1.resolved!.work_id));
  assert.equal(w.title_status, "confirmed");
  assert.deepEqual(w.title_source_ids, [sidOf(fan), sidOf(pub)].sort());
  assert.ok(w.history.some((h) => h.event === "title_confirmed"));
});

// ------------------------------------------------------------------ §1.3 provenance and budget

test("self-reported URLs never reach the fetcher; they are rejected with a gap", async () => {
  const worksDir = tmpWorks();
  const { run, fetcher } = madokaRun(worksDir, "まどマギ", "job-sr");
  const r = await run();
  assert.equal(r.status, "resolved");
  assert.ok(!fetcher.requested.includes(U_FAKE));
  assert.deepEqual(fetcher.requested.sort(), [U_OFFICIAL, U_WIKI].sort());
  assert.equal(r.metrics.self_reported_rejected, 1);
  const cand = JSON.parse(fs.readFileSync(path.join(worksDir, WID, "research", "candidates.json"), "utf8"));
  assert.ok(cand.rejected.some((x: { url: string; reason: string }) => x.url === U_FAKE && x.reason === "self_reported"));
  for (const s of cand.selected as Candidate[]) assert.equal(s.origin.kind, "search_event");
  const gaps = JSON.parse(fs.readFileSync(path.join(worksDir, WID, "research", "gaps.json"), "utf8")) as ResearchGap[];
  assert.ok(gaps.some((g) => g.kind === "self_reported_url" && g.url === U_FAKE));
  const cards = JSON.parse(fs.readFileSync(path.join(worksDir, WID, "research", "sources.json"), "utf8")) as SourceCard[];
  for (const c of cards) assert.equal(c.origin.kind, "search_event");
  for (const f of ["search_log.json", "candidates.json", "fetch_log.json", "sources.json", "gaps.json", "budget.json", "identify_job-sr.json"]) {
    assert.ok(fs.existsSync(path.join(worksDir, WID, "research", f)), f);
  }
});

test("at most 5 searches and 8 fetches, counted into the job budget", async () => {
  const worksDir = tmpWorks();
  const urls = Array.from({ length: 12 }, (_, i) => `https://site${i}.example/p`);
  // 7 search events (model over-searched): results of searches 6-7 are ignored → their URLs count as self-reported
  const events: WebSearchEvent[] = Array.from({ length: 7 }, (_, i) => ({
    itemId: `ws${i}`, action: "search" as const, query: `q${i}`, url: null,
    results: urls.slice(i * 2, i * 2 + 2).map((u) => ({ url: u, title: u, domain: new URL(u).hostname, snippet: "" })),
  }));
  const pages = Object.fromEntries(urls.map((u, i) => [u, page("T3", `site${i}.example`)]));
  const luna = fakeLuna({ searchEvents: events, selections: urls, candidates: [] });
  const fetcher = new FakeFetcher(pages);
  const d = deps(worksDir, luna, fetcher, freshBudget({ searchesUsed: 3, fetchesUsed: 10 }));
  const r = await identify({ jobId: "jb", workQuery: "なにか", mediumHint: null }, d);
  assert.equal(r.status, "clarifying");
  assert.equal(d.budget.searchesUsed, 3 + 5);
  assert.equal(r.metrics.searches_used, 5);
  assert.equal(r.metrics.searches_observed, 7);
  assert.ok(fetcher.requested.length <= 8);
  assert.equal(fetcher.requested.length, 8);
  assert.equal(d.budget.fetchesUsed, 10 + 8);
  assert.ok(fetcher.requested.every((u) => urls.slice(0, 10).includes(u)));
  assert.match(luna.calls[0].prompt, /最大 5 回/);
  const budget = JSON.parse(fs.readFileSync(path.join(worksDir, "_staging-jb", "research", "budget.json"), "utf8")) as BudgetState;
  assert.equal(budget.fetchesUsed, 18);
});

test("identification respects a nearly exhausted job budget; an exhausted search budget skips the model", async () => {
  const worksDir = tmpWorks();
  const urls = Array.from({ length: 6 }, (_, i) => `https://site${i}.example/p`);
  const pages = Object.fromEntries(urls.map((u, i) => [u, page("T3", `site${i}.example`)]));
  const luna = fakeLuna({ results: urls, candidates: [] });
  const fetcher = new FakeFetcher(pages);
  const d = deps(worksDir, luna, fetcher, freshBudget({ searchesUsed: 38, fetchesUsed: 57 }));
  await identify({ jobId: "jn", workQuery: "なにか", mediumHint: null }, d);
  assert.match(luna.calls[0].prompt, /最大 2 回/);
  assert.equal(d.budget.searchesUsed, 39);
  assert.equal(fetcher.requested.length, 3);
  assert.equal(d.budget.fetchesUsed, 60);
  const log = JSON.parse(fs.readFileSync(path.join(worksDir, "_staging-jn", "research", "fetch_log.json"), "utf8")) as FetchDecision[];
  assert.equal(log.filter((x) => x.decision === "budget_exceeded").length, 3);

  const luna2 = fakeLuna({ results: urls, candidates: [] });
  const d2 = deps(worksDir, luna2, new FakeFetcher(pages), freshBudget({ searchesUsed: 40 }));
  const r2 = await identify({ jobId: "jx", workQuery: "なにか", mediumHint: null }, d2);
  assert.equal(luna2.calls.length, 0);
  assert.equal(r2.status, "clarifying");
  assert.equal(r2.reason, "no_candidates");
});

// ------------------------------------------------------------------ multiple candidates / medium hint / reading

function tokiRun(worksDir: string, hint: string | null, jobId: string) {
  const uN = "https://bunko.example/toki";
  const uF = "https://film.example/toki";
  const pages = {
    [uN]: { tier: "T1" as Tier, site_key: "bunko.example", text: "筒井康隆『時をかける少女』（ときをかけるしょうじょ）1967年刊行。" },
    [uF]: { tier: "T1" as Tier, site_key: "film.example", text: "アニメーション映画『時をかける少女』2006年公開。監督：細田守" },
  };
  const cands: ExtractedCandidate[] = [
    { title: "時をかける少女", title_original: null, title_reading: "とき を かける しょうじょ", medium: "novel", creators: ["筒井康隆"], first_release_year: 1967,
      evidence: [{ source_id: sidOf(uN), quote: "筒井康隆『時をかける少女』" }], aliases_seen: [] },
    { title: "時をかける少女", title_original: null, title_reading: "とき を かける しょうじょ", medium: "film", creators: ["細田守"], first_release_year: 2006,
      evidence: [{ source_id: sidOf(uF), quote: "アニメーション映画『時をかける少女』" }], aliases_seen: [] },
    // duplicate of the novel candidate with a later (wrong) year → grouped, earliest year kept
    { title: "時をかける 少女", title_original: null, title_reading: null, medium: "novel", creators: [], first_release_year: 1976,
      evidence: [{ source_id: sidOf(uN), quote: "『時をかける少女』（ときをかけるしょうじょ）" }], aliases_seen: [] },
  ];
  const luna = fakeLuna({ results: [uN, uF], candidates: cands });
  return identify({ jobId, workQuery: "時かけ", mediumHint: hint }, deps(worksDir, luna, new FakeFetcher(pages)));
}

test("same title, novel vs film → clarifying with candidates; medium_hint narrows to resolved", async () => {
  const worksDir = tmpWorks();
  const r = await tokiRun(worksDir, null, "jt1");
  assert.equal(r.status, "clarifying");
  assert.equal(r.reason, "multiple_candidates");
  assert.deepEqual(
    r.candidates!.map((c) => [c.title, c.medium, c.first_release_year]).sort(),
    [["時をかける少女", "film", 2006], ["時をかける少女", "novel", 1967]],
  );
  assert.equal(readIndexFile(worksDir).works.length, 0, "nothing written to the ledger while clarifying");

  const r2 = await tokiRun(worksDir, "novel", "jt2");
  assert.equal(r2.status, "resolved");
  assert.equal(r2.resolved!.work_id, "novel-toki-o-kakeru-shoujo-1967");
  const r3 = await tokiRun(worksDir, "movie", "jt3");
  assert.equal(r3.status, "resolved");
  assert.equal(r3.resolved!.work_id, "film-toki-o-kakeru-shoujo-2006");

  // INDEX now has two works with the same title → "時をかける少女" is ambiguous; the hint resolves it without the model
  const luna = fakeLuna({ candidates: [] });
  const amb = await identify({ jobId: "jt4", workQuery: "時をかける少女", mediumHint: null }, deps(worksDir, luna, new FakeFetcher({})));
  assert.equal(amb.status, "clarifying");
  assert.equal(amb.reason, "multiple_index_matches");
  assert.equal(amb.candidates!.length, 2);
  const one = await identify({ jobId: "jt5", workQuery: "時をかける少女", mediumHint: "novel" }, deps(worksDir, luna, new FakeFetcher({})));
  assert.equal(one.resolved!.method, "index_match");
  assert.equal(one.resolved!.work_id, "novel-toki-o-kakeru-shoujo-1967");
  assert.equal(luna.calls.length, 0);
});

test("no usable kana reading → clarifying no_reading, no work created", async () => {
  const worksDir = tmpWorks();
  const u = "https://pub.example/a";
  const cand: ExtractedCandidate = {
    title: "テスト作品", title_original: null, title_reading: "テスト作品", medium: "novel", creators: [], first_release_year: 2001,
    evidence: [{ source_id: sidOf(u), quote: "『テスト作品』は" }], aliases_seen: [],
  };
  const r = await identify({ jobId: "jr", workQuery: "テスト作品", mediumHint: null }, deps(worksDir, fakeLuna({ results: [u], candidates: [cand] }), new FakeFetcher({ [u]: page("T1", "pub.example") })));
  assert.equal(r.status, "clarifying");
  assert.equal(r.reason, "no_reading");
  assert.equal(readIndexFile(worksDir).works.length, 0);
});

test("verified aliases_seen are recorded as attested; unverifiable ones are dropped", async () => {
  const worksDir = tmpWorks();
  const luna = fakeLuna({
    results: [U_OFFICIAL, U_WIKI],
    candidates: [{
      ...madokaCandidate({ aliasesSeen: true }),
      aliases_seen: [
        { text: "まどマギ", kind: "common", source_id: sidOf(U_WIKI), quote: "略称は「まどマギ」" },
        { text: "まどまぎ", kind: "official_alt", source_id: sidOf(U_WIKI), quote: "略称は「まどまぎ」" }, // not in text
      ],
    }],
  });
  const r = await identify({ jobId: "jal", workQuery: TITLE, mediumHint: null }, deps(worksDir, luna, new FakeFetcher(PAGES)));
  assert.equal(r.status, "resolved");
  assert.equal(r.resolved!.alias_recorded, false, "input equals the title");
  assert.equal(r.notice, undefined);
  const w = readWork(path.join(worksDir, WID));
  assert.deepEqual(w.aliases.map((a) => [a.text, a.kind, a.attested, a.source_ids]), [["まどマギ", "common", true, [sidOf(U_WIKI)]]]);
  assert.equal(r.metrics.aliases_dropped, 1);
});

// ------------------------------------------------------------------ A16: installment selector

test("A16: 「N作目」 never resolves to the base work through the index shortcut", async () => {
  const worksDir = tmpWorks();
  const U_BASE = "https://example.jp/matrix1999";
  const U_SEQ = "https://example.jp/matrix-reloaded";
  const pages: Record<string, Page> = {
    [U_BASE]: { tier: "T1", site_key: "example.jp", text: "映画『マトリックス』公式ページ\n1999年公開。監督：ウォシャウスキー姉妹" },
    [U_SEQ]: { tier: "T1", site_key: "example.jp", text: "映画『マトリックス リローデッド』公式ページ\n2003年公開。監督：ウォシャウスキー姉妹" },
  };
  const cand = (title: string, reading: string, year: number, url: string, quote: string): ExtractedCandidate => ({
    title, title_original: null, title_reading: reading, medium: "film",
    creators: ["ウォシャウスキー"], first_release_year: year,
    evidence: [{ source_id: sidOf(url), quote }], aliases_seen: [],
  });
  // 1. the base work enters the index
  const luna1 = fakeLuna({ results: [U_BASE], candidates: [cand("マトリックス", "まっとりくす", 1999, U_BASE, "映画『マトリックス』公式ページ")] });
  const r1 = await identify({ jobId: "job-a16-1", workQuery: "マトリックス", mediumHint: null }, deps(worksDir, luna1, new FakeFetcher(pages)));
  assert.equal(r1.status, "resolved");
  const baseId = r1.resolved!.work_id;
  // 2. the same query with installment 2 must research and resolve the sequel, not the base work
  const luna2 = fakeLuna({ results: [U_SEQ], candidates: [cand("マトリックス リローデッド", "まっとりくす りろーでっど", 2003, U_SEQ, "映画『マトリックス リローデッド』公式ページ")] });
  const r2 = await identify({ jobId: "job-a16-2", workQuery: "マトリックス", mediumHint: null, installment: 2 }, deps(worksDir, luna2, new FakeFetcher(pages)));
  assert.equal(r2.status, "resolved");
  assert.equal(r2.resolved!.title, "マトリックス リローデッド");
  assert.notEqual(r2.resolved!.work_id, baseId);
  assert.notEqual(r2.resolved!.method, "index_match");
  const searchCall = luna2.calls.find((c) => c.task === "s0.identify.search");
  assert.ok(searchCall && searchCall.prompt.includes("第2作目"), "search prompt carries the installment instruction");
});
