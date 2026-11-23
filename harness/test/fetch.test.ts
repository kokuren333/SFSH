import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import {
  createFetcher, normalizeUrl, sourceIdFor, parseRobots, robotsForStatus, loadDenylist, isDenied,
  resolveTier, siteKey, extractMainText, decodeBody, decodeEntities, isPrivateIp, USER_AGENT,
} from "../src/research/fetch/index.ts";
import type { Candidate, FetchContext } from "../src/research/types.ts";

const fixtures = fileURLToPath(new URL("./fixtures/fetch/", import.meta.url));
const candidate = (url: string): Candidate => ({ url, origin: { kind: "instruction", note: "local fixture" } });

async function context(t: TestContext, fetches = 30): Promise<FetchContext> {
  await mkdir(fixtures, { recursive: true });
  const workDir = await mkdtemp(join(fixtures, ".run-"));
  t.after(async () => {
    // Validate the absolute cleanup target remains within the explicitly owned fixture tree.
    assert.ok(resolve(workDir).startsWith(resolve(fixtures) + sep));
    assert.ok(workDir.slice(fixtures.length).replace(/^[/\\]/, "").startsWith(".run-"));
    await rm(workDir, { recursive: true, force: true });
  });
  return { workDir, existing: [], allowPrivateAddresses: true,
    budget: { limits: { searches: 0, fetches, wallMs: 120_000 }, searchesUsed: 0, fetchesUsed: 0, startedAt: new Date().toISOString() } };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
async function localServer(t: TestContext, handler?: Handler) {
  const log: { path: string; at: number; ua?: string; accept?: string }[] = [];
  const server = createServer((req, res) => {
    log.push({ path: req.url!, at: Date.now(), ua: req.headers["user-agent"], accept: req.headers.accept });
    if (handler) void Promise.resolve(handler(req, res)).catch(() => res.destroy());
    else if (req.url === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("User-agent: *\nDisallow: /private/\n"); }
    else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<title>Title</title><main>Evidence for ${req.url}</main>`); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, log };
}

function respond(res: ServerResponse, status: number, body = "", type = "text/html") {
  res.writeHead(status, { "Content-Type": type }); res.end(body);
}

test("normalizeUrl preserves retained query spelling/order and source IDs are stable", () => {
  const url = "HTTPS://ExAmPlE.COM:443/a?z=%20&utm_source=ignored&a=1+2&fbclid=x&a=3&gclid=y#fragment";
  const expected = "https://example.com/a?z=%20&a=1+2&a=3";
  assert.equal(normalizeUrl(url), expected);
  assert.equal(normalizeUrl("http://EXAMPLE.com:80/"), "http://example.com/");
  assert.equal(normalizeUrl("http://example.com:8080/?b=2&a=1"), "http://example.com:8080/?b=2&a=1");
  assert.equal(sourceIdFor(url), sourceIdFor(expected));
  assert.equal(sourceIdFor(url), "s" + createHash("sha256").update(expected).digest("hex").slice(0, 10));
  assert.notEqual(sourceIdFor("https://example.com/?a=1&b=2"), sourceIdFor("https://example.com/?b=2&a=1"));
});

test("robots selects and merges our named groups, ignoring wildcard groups", () => {
  const robots = parseRobots("User-agent: *\nDisallow: /\nUser-agent: sfsh-RESEARCH\nDisallow: /a\n\nUser-agent: other\nDisallow: /b\nUser-agent: SFSH-research\nDisallow: /c");
  assert.equal(robots.allowed("/ok"), true);
  assert.equal(robots.allowed("/a"), false);
  assert.equal(robots.allowed("/b"), true);
  assert.equal(robots.allowed("/c"), false);
  assert.equal(parseRobots("User-agent: other\nDisallow: /\nUser-agent: *\nDisallow: /x").allowed("/x"), false);
  assert.equal(parseRobots("User-agent: other\nDisallow: /").allowed("/x"), true);
});

test("robots longest match and Allow wins equal-length matches", () => {
  const robots = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/public\nDisallow: /tie\nAllow: /tie\nDisallow: /a/public/secret\nDisallow:\n");
  assert.equal(robots.allowed("/abc"), false);
  assert.equal(robots.allowed("/a/public/info"), true);
  assert.equal(robots.allowed("/a/public/secret"), false);
  assert.equal(robots.allowed("/tie"), true);
  assert.equal(robots.allowed("/other"), true);
});

test("robots wildcard, end anchor, case sensitivity and percent octets", () => {
  const robots = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /find?*private\nDisallow: /~name\nDisallow: /日本語\nDisallow: /encoded%2Fpath");
  assert.equal(robots.allowed("https://example.test/a/b.pdf"), false);
  assert.equal(robots.allowed("/a.pdf?download=1"), true);
  assert.equal(robots.allowed("/a.PDF"), true);
  assert.equal(robots.allowed("/find?q=private"), false);
  assert.equal(robots.allowed("/%7ename"), false);
  assert.equal(robots.allowed("/%E6%97%A5%E6%9C%AC%E8%AA%9E"), false);
  assert.equal(robots.allowed("/encoded%2fpath"), false);
  assert.equal(robots.allowed("/encoded/path"), true);
  assert.equal(parseRobots("User-agent: *\nDisallow: /").allowed("/robots.txt"), true);
});

test("robots HTTP policy: all 4xx allow; 5xx, network and unresolved redirects disallow", () => {
  for (const status of [400, 401, 403, 404, 429, 499]) assert.equal(robotsForStatus(status).allowed("/x"), true);
  for (const status of [0, 301, 500, 503, 599]) assert.equal(robotsForStatus(status).allowed("/x"), false);
  assert.equal(robotsForStatus(200, "User-agent: *\nDisallow: /x").allowed("/x"), false);
});

test("denylist suffix boundaries, categories and Aozora text/card distinction", () => {
  const injected = loadDenylist({ domains: [{ domain: "blocked.test", reason: "fixture" }], patterns: [{ pattern: "/pirate/", reason: "path" }] });
  assert.deepEqual(isDenied("https://a.blocked.test/", injected), { denied: true, reason: "fixture" });
  assert.equal(isDenied("https://notblocked.test/", injected).denied, false);
  assert.equal(isDenied("https://allowed.test/pirate/file", injected).reason, "path");
  for (const host of ["uta-net.com", "j-lyric.net", "utaten.com", "kget.jp", "petitlyrics.com", "lyrical-nonsense.com", "opensubtitles.org", "subscene.com", "kitsunekko.net", "archive.ph", "archive.today", "12ft.io", "rawkuma.com", "nyaa.si", "mediafire.com"]) assert.equal(isDenied(`https://www.${host}/`).denied, true, host);
  assert.equal(isDenied("https://www.aozora.gr.jp/cards/0001/files/1.html").denied, true);
  assert.equal(isDenied("https://www.aozora.gr.jp/cards/0001/card1.html").denied, false);
  assert.equal(isDenied("https://www.aozora.gr.jp/cards/0001/%66iles/1.html").denied, true);
});

test("tiers resolve table before model before default and record Wikipedia license", () => {
  assert.deepEqual(resolveTier("https://ja.wikipedia.org/wiki/X", { tierSuggested: "T1" }), { tier: "T3", tier_basis: "table", license: "CC BY-SA 4.0" });
  assert.equal(resolveTier("https://en.wikipedia.org/wiki/X").license, "CC BY-SA 4.0");
  assert.deepEqual(resolveTier("https://unknown.test/", { tierSuggested: "T2" }), { tier: "T2", tier_basis: "model_suggested", license: null });
  assert.deepEqual(resolveTier("https://unknown.test/"), { tier: "T4", tier_basis: "default", license: null });
  for (const host of ["ndl.go.jp", "crd.ndl.go.jp", "ci.nii.ac.jp", "bunka.go.jp", "mediaarts-db.artmuseums.go.jp", "kodansha.co.jp", "shueisha.co.jp", "shogakukan.co.jp", "kadokawa.co.jp", "shinchosha.co.jp", "chikumashobo.co.jp", "iwanami.co.jp", "aniplex.co.jp"]) assert.equal(resolveTier(`https://${host}/`).tier, "T1", host);
  for (const host of ["asahi.com", "mainichi.jp", "yomiuri.co.jp", "nikkei.com", "sankei.com", "nhk.or.jp", "natalie.mu", "animatetimes.com", "oricon.co.jp", "mantan-web.jp"]) assert.equal(resolveTier(`https://${host}/`).tier, "T2", host);
  assert.equal(resolveTier("https://dic.pixiv.net/").tier_basis, "table");
  assert.equal(resolveTier("https://notasahi.com/").tier_basis, "default");
});

test("siteKey approximates registrable domains", () => {
  assert.equal(siteKey("www.asahi.com"), "asahi.com");
  assert.equal(siteKey("www.kodansha.co.jp"), "kodansha.co.jp");
  assert.equal(siteKey("ja.wikipedia.org"), "wikipedia.org");
  assert.equal(siteKey("www.example.co.uk"), "example.co.uk");
  assert.equal(siteKey("www.example.gov.au"), "example.gov.au");
});

test("extraction removes excluded elements, prefers main, decodes entities and takes title/publisher", () => {
  const page = extractMainText(`<html><head><title>Research &amp; title</title><meta content="Publisher &amp; Co" property="og:site_name"></head><body>
    <p>Outside main</p><nav>nav text</nav><main><h1>見出し</h1><p>A &amp; B &#x65e5; &#26412; &copy;</p>
    <script>const fake = '<main>Bad</main>';</script><style>bad style</style><noscript>bad noscript</noscript><svg>bad svg</svg><header>bad header</header><aside>bad aside</aside><form>bad form</form><iframe>bad iframe</iframe><!-- bad comment --><footer>bad footer</footer><p data-x=">">End</p></main></body></html>`, "https://example.test/");
  assert.equal(page.title, "Research & title");
  assert.equal(page.publisher, "Publisher & Co");
  assert.match(page.text, /見出し\n/);
  assert.match(page.text, /A & B 日 本 ©/);
  assert.match(page.text, /End$/);
  assert.doesNotMatch(page.text, /Outside|bad|nav text|fake/i);
});

test("extraction prefers Wikipedia content/article and caps text", () => {
  assert.equal(extractMainText('<main>other</main><div id="mw-content-text"><p>Wiki</p></div>', "https://ja.wikipedia.org/").text, "Wiki");
  assert.equal(extractMainText("<div>outside</div><article>Article</article>", "https://example.test/").text, "Article");
  const extracted = extractMainText(`<body><nav>Menu</nav><p>${"a".repeat(61_000)}</p><footer>Footer</footer></body>`, "https://example.test/");
  assert.equal(extracted.text.length, 60_000);
  assert.equal(extracted.publisher, "example.test");
});

test("HTML entities cover named/Unicode/numeric references and attribute ambiguity", () => {
  assert.equal(decodeEntities("&eacute; &Eacute; &Alpha; &NotEqualTilde; &#x1f600; &#128;"), "é É Α ≂̸ 😀 €");
  assert.equal(decodeEntities("&amp &notit; &unknown; &#0; &#x110000;"), "& ¬it; &unknown; � �");
  assert.equal(decodeEntities("&amp=x &amp;=x", true), "&amp=x &=x");
  assert.equal(decodeEntities("&amp;amp;"), "&amp;");
});

test("charset header precedes meta; http-equiv is sniffed; UTF-8 is the fallback", () => {
  assert.equal(decodeBody(new TextEncoder().encode('<meta charset="Shift_JIS">日本語'), "text/html; charset=utf-8"), '<meta charset="Shift_JIS">日本語');
  assert.equal(decodeBody(new Uint8Array([0x93, 0xfa, 0x96, 0x7b]), "text/plain; charset=Shift_JIS"), "日本");
  const prefix = new TextEncoder().encode('<meta content="text/html; charset=Shift_JIS" http-equiv="Content-Type">');
  assert.match(decodeBody(Buffer.concat([prefix, Buffer.from([0x93, 0xfa, 0x96, 0x7b])]), "text/html"), /日本$/);
  assert.equal(decodeBody(new TextEncoder().encode("日本語"), "text/plain"), "日本語");
  assert.equal(decodeBody(new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc]), "text/plain; charset=euc-jp"), "日本");
  assert.equal(decodeBody(new Uint8Array([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42]), "text/plain; charset=iso-2022-jp"), "日本");
});

test("private addresses include required IPv4 ranges and mapped IPv6", () => {
  for (const address of ["127.0.0.2", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "::1", "::ffff:127.0.0.1", "::ffff:a00:1", "fc00::1", "fe80::1"]) assert.equal(isPrivateIp(address), true, address);
  for (const address of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "8.8.8.8", "2001:4860:4860::8888"]) assert.equal(isPrivateIp(address), false, address);
});

test("denylisted URLs are never requested, including redirect targets", async (t) => {
  const { base, log } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 404);
    else if (req.url === "/redirect") { res.writeHead(302, { Location: "/pirate/target" }); res.end(); }
    else respond(res, 200, "<main>Must not fetch</main>");
  });
  const ctx = await context(t);
  const fetcher = createFetcher({ denylist: { domains: [], patterns: [{ pattern: "/pirate/", reason: "fixture piracy" }] } });
  const result = await fetcher.fetchAll([candidate(base + "/pirate/direct"), candidate(base + "/redirect")], ctx);
  assert.deepEqual(result.decisions.map((d) => d.decision), ["denylisted", "denylisted"]);
  assert.equal(result.decisions[1].finalUrl, base + "/pirate/target");
  assert.equal(result.decisions[1].status, 302);
  assert.equal(result.cards.length, 0);
  assert.equal(result.gaps.length, 2);
  assert.equal(ctx.budget.fetchesUsed, 1);
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt", "/redirect"]);
  await assert.rejects(readdir(join(ctx.workDir, "research", "raw")), { code: "ENOENT" });
});

test("robots disallow prevents page GET; per-origin cache lives across batches", async (t) => {
  const { base, log } = await localServer(t);
  const ctx = await context(t);
  // CP-035 c: the interval is measured on the client side (send times), not on server receipt — the server-side
  // receipt time includes scheduling delay under load and made this check flaky (M3 final run).
  const sent: { url: string; at: number }[] = [];
  const fetcher = createFetcher({ onRequest: (url, at) => sent.push({ url, at }) });
  const first = await fetcher.fetchAll([candidate(base + "/private/a"), candidate(base + "/good/a")], ctx);
  const second = await fetcher.fetchAll([candidate(base + "/good/b")], ctx);
  assert.deepEqual(first.decisions.map((d) => d.decision), ["robots_disallowed", "fetched"]);
  assert.equal(second.cards.length, 1);
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt", "/good/a", "/good/b"]);
  assert.equal(ctx.budget.fetchesUsed, 2);
  for (const request of log) { assert.equal(request.ua, USER_AGENT); assert.equal(request.accept, "text/html,text/plain;q=0.9"); }
  assert.deepEqual(sent.map((r) => new URL(r.url).pathname), ["/robots.txt", "/good/a", "/good/b"]);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 1000, `requests to one host are sent >= 1000 ms apart (got ${sent[i].at - sent[i - 1].at} ms)`);
});

test("budget 2 allows exactly 2 page GETs among 4 candidates", async (t) => {
  const { base, log } = await localServer(t);
  const ctx = await context(t, 2);
  const result = await createFetcher().fetchAll([1, 2, 3, 4].map((n) => candidate(`${base}/good/${n}`)), ctx);
  assert.deepEqual(result.decisions.map((d) => d.decision), ["fetched", "fetched", "budget_exceeded", "budget_exceeded"]);
  assert.equal(result.cards.length, 2);
  assert.equal(result.gaps.length, 2);
  assert.ok(result.gaps.every((g) => g.kind === "budget_exhausted"));
  assert.equal(log.filter((r) => r.path !== "/robots.txt").length, 2);
  assert.equal(ctx.budget.fetchesUsed, 2);
  for (const card of result.cards) {
    assert.equal(card.raw_text_path, `research/raw/${card.source_id}.txt`);
    const text = await readFile(join(ctx.workDir, card.raw_text_path), "utf8");
    assert.equal(card.content_hash, "sha256:" + createHash("sha256").update(text).digest("hex"));
    assert.equal(card.text_chars, text.length);
    assert.deepEqual(card.excerpts, []);
    assert.match(card.fetched_at, /[+-]\d{2}:\d{2}$/);
    assert.match(await readFile(join(ctx.workDir, "research", "raw", `${card.source_id}.html`), "utf8"), /<main>/);
  }
  assert.equal((await readdir(join(ctx.workDir, "research", "raw"))).length, 4);
});

test("job finishes when denylist, robots, budget and HTTP/type failures mix with good pages", async (t) => {
  const { base, log } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 200, "User-agent: *\nDisallow: /private/", "text/plain");
    else if (req.url === "/404") respond(res, 404);
    else if (req.url === "/pdf") respond(res, 200, "pdf bytes", "application/pdf");
    else respond(res, 200, `<main>Good page ${req.url}</main>`);
  });
  const paths = ["/pirate/a", "/private/a", "/good/1", "/404", "/pdf", "/good/2", "/over"];
  const ctx = await context(t, 4);
  const result = await createFetcher({ denylist: { domains: [], patterns: [{ pattern: "/pirate/", reason: "piracy" }] } }).fetchAll(paths.map((p) => candidate(base + p)), ctx);
  const expected = ["denylisted", "robots_disallowed", "fetched", "http_error", "unsupported_type", "fetched", "budget_exceeded"];
  assert.deepEqual(result.decisions.map((d) => d.decision), expected);
  assert.deepEqual(result.decisions.map((d) => d.url), paths.map((p) => base + p));
  assert.equal(result.cards.length, 2);
  assert.deepEqual(result.cards.map((c) => c.final_url), [base + "/good/1", base + "/good/2"]);
  assert.equal(result.gaps.length, 5);
  assert.deepEqual(result.gaps.map((g) => g.url), paths.filter((_, i) => expected[i] !== "fetched").map((p) => base + p));
  for (const gap of result.gaps) assert.match(gap.detail, new RegExp(expected[paths.indexOf(gap.url!.slice(base.length))] + ": .+"));
  assert.equal(result.decisions[3].status, 404);
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt", "/good/1", "/404", "/pdf", "/good/2"]);
  assert.equal((await readdir(join(ctx.workDir, "research", "raw"))).length, 4);
});

test("Shift_JIS meta fixture decodes correctly through fetch and saved raw text", async (t) => {
  const bytes = await readFile(join(fixtures, "shift_jis.html"));
  const { base } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 404);
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end(bytes); }
  });
  const ctx = await context(t);
  const result = await createFetcher().fetchAll([candidate(base + "/sjis")], ctx);
  assert.equal(result.decisions[0].decision, "fetched");
  assert.equal(result.cards[0].title, "日本語の調査");
  assert.equal(await readFile(join(ctx.workDir, result.cards[0].raw_text_path), "utf8"), "日本語の本文です。");
});

test("invalid URLs, duplicates and private addresses follow the required check order", async (t) => {
  const { base, log } = await localServer(t);
  const ctx = await context(t, 0);
  ctx.allowPrivateAddresses = false;
  const candidates = [candidate("not a URL"), candidate("file:///secret"), candidate(base + "/x"), candidate(base + "/x#fragment"), candidate("http://localhost/private")];
  const result = await createFetcher({ denylist: { domains: [{ domain: "127.0.0.1", reason: "fixture" }], patterns: [] } }).fetchAll(candidates, ctx);
  assert.deepEqual(result.decisions.map((d) => d.decision), ["network_error", "network_error", "private_address", "duplicate", "private_address"]);
  assert.equal(log.length, 0);
  assert.equal(result.gaps.length, 4);
});

test("existing cards and equal text hashes deduplicate without extra files", async (t) => {
  const { base, log } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 404);
    else respond(res, 200, "<main>Same evidence</main>");
  });
  const ctx = await context(t);
  const fetcher = createFetcher();
  const initial = await fetcher.fetchAll([candidate(base + "/one")], ctx);
  ctx.existing = initial.cards;
  const next = await fetcher.fetchAll([candidate(base + "/one?utm_source=test#top"), candidate(base + "/two"), candidate(base + "/two")], ctx);
  assert.deepEqual(next.decisions.map((d) => d.decision), ["duplicate", "duplicate", "duplicate"]);
  assert.equal(next.cards.length, 0);
  assert.equal(next.gaps.length, 0);
  assert.equal(ctx.budget.fetchesUsed, 2);
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt", "/one", "/two"]);
  assert.equal((await readdir(join(ctx.workDir, "research", "raw"))).length, 2);
});

test("redirect hops count as one fetch and robots is rechecked at the target", async (t) => {
  const { base, log } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 200, "User-agent: *\nDisallow: /private/", "text/plain");
    else if (req.url === "/start") { res.writeHead(302, { Location: "/middle" }); res.end(); }
    else if (req.url === "/middle") { res.writeHead(307, { Location: "/good" }); res.end(); }
    else if (req.url === "/blocked") { res.writeHead(301, { Location: "/private/secret" }); res.end(); }
    else respond(res, 200, `<main>Redirect final ${req.url}</main>`);
  });
  const ctx = await context(t, 1);
  const fetcher = createFetcher();
  const result = await fetcher.fetchAll([candidate(base + "/start")], ctx);
  assert.equal(result.decisions[0].decision, "fetched");
  assert.equal(result.cards[0].source_id, sourceIdFor(base + "/start"));
  assert.equal(result.cards[0].final_url, base + "/good");
  assert.equal(ctx.budget.fetchesUsed, 1);
  ctx.budget.limits.fetches++;
  const blocked = await fetcher.fetchAll([candidate(base + "/blocked")], ctx);
  assert.equal(blocked.decisions[0].decision, "robots_disallowed");
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt", "/start", "/middle", "/good", "/blocked"]);
});

test("wall budget blocks initial requests and is rechecked after robots", async (t) => {
  const { base, log } = await localServer(t);
  const ctx = await context(t);
  ctx.now = () => new Date(Date.parse(ctx.budget.startedAt) + 120_000);
  const fetcher = createFetcher();
  assert.equal((await fetcher.fetchAll([candidate(base + "/expired")], ctx)).decisions[0].decision, "budget_exceeded");
  assert.equal(log.length, 0);
  let checks = 0;
  ctx.now = () => new Date(Date.parse(ctx.budget.startedAt) + (++checks >= 3 ? 120_000 : 0));
  assert.equal((await fetcher.fetchAll([candidate(base + "/wait-expired")], ctx)).decisions[0].decision, "budget_exceeded");
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt"]);
  assert.equal(ctx.budget.fetchesUsed, 0);
});

test("robots 5xx and timeout fail closed without attempting pages", async (t) => {
  for (const mode of ["5xx", "timeout", "network"] as const) {
    const { base, log } = await localServer(t, (req, res) => {
      if (req.url === "/robots.txt") {
        if (mode === "5xx") respond(res, 503);
        else if (mode === "network") res.destroy();
        // timeout: deliberately leave the response open until AbortController cancels it.
      } else respond(res, 200, "<main>Must not fetch</main>");
    });
    const ctx = await context(t);
    const result = await createFetcher({ timeoutMs: 80 }).fetchAll([candidate(base + "/a"), candidate(base + "/b")], ctx);
    assert.deepEqual(result.decisions.map((d) => d.decision), ["robots_disallowed", "robots_disallowed"]);
    assert.deepEqual(log.map((r) => r.path), ["/robots.txt"]);
    assert.equal(ctx.budget.fetchesUsed, 0);
  }
});

test("body size cap covers Content-Length and streaming bodies; plain text is preserved", async (t) => {
  const { base } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 404);
    else if (req.url === "/length") { res.writeHead(200, { "Content-Type": "text/html", "Content-Length": 3 * 1024 * 1024 + 1 }); res.end(); }
    else if (req.url === "/stream") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("a".repeat(3 * 1024 * 1024 + 1)); }
    else respond(res, 200, "  Literal <tag> &amp; text  ", "text/plain; charset=utf-8");
  });
  const ctx = await context(t);
  const result = await createFetcher().fetchAll(["/length", "/stream", "/plain"].map((p) => candidate(base + p)), ctx);
  assert.deepEqual(result.decisions.map((d) => d.decision), ["too_large", "too_large", "fetched"]);
  assert.equal(result.gaps.length, 2);
  assert.equal(await readFile(join(ctx.workDir, result.cards[0].raw_text_path), "utf8"), "Literal <tag> &amp; text");
  assert.equal((await readdir(join(ctx.workDir, "research", "raw"))).length, 2);
});

test("page timeouts are per-URL failures and later pages still fetch", async (t) => {
  const { base, log } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 404);
    else if (req.url === "/slow") { res.writeHead(200, { "Content-Type": "text/html" }); res.write("<main>"); }
    else respond(res, 200, "<main>Recovered</main>", "application/xhtml+xml");
  });
  const ctx = await context(t);
  const result = await createFetcher({ timeoutMs: 80 }).fetchAll([candidate(base + "/slow"), candidate(base + "/ok")], ctx);
  assert.deepEqual(result.decisions.map((d) => d.decision), ["network_error", "fetched"]);
  assert.equal(ctx.budget.fetchesUsed, 2);
  assert.equal(result.cards.length, 1);
  assert.deepEqual(log.map((r) => r.path), ["/robots.txt", "/slow", "/ok"]);
});

test("redirect limit stops after five redirects and unsafe redirect URLs never GET", async (t) => {
  const { base, log } = await localServer(t, (req, res) => {
    if (req.url === "/robots.txt") respond(res, 404);
    else { res.writeHead(302, { Location: req.url === "/unsafe" ? "file:///secret" : "/loop" }); res.end(); }
  });
  const ctx = await context(t);
  const result = await createFetcher().fetchAll([candidate(base + "/loop"), candidate(base + "/unsafe")], ctx);
  assert.deepEqual(result.decisions.map((d) => d.decision), ["http_error", "network_error"]);
  assert.equal(log.filter((r) => r.path === "/loop").length, 6);
  assert.equal(ctx.budget.fetchesUsed, 2);
});

test("programmer errors reject fetchAll", async (t) => {
  const ctx = await context(t);
  ctx.budget.startedAt = "invalid";
  await assert.rejects(createFetcher().fetchAll([], ctx), TypeError);
  assert.throws(() => createFetcher({ denylist: { domains: [], patterns: [{ pattern: "[", reason: "invalid regex" }] } }), SyntaxError);
});
