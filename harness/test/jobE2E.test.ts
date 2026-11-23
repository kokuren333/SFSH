/**
 * M1 gate (REQUIREMENTS v1.3 §7.4, M1 row), job level: a whole job (S0 → S1 → S2 → check) runs against a local
 * HTTP server with the REAL fetcher and fake models. The fetcher never requests denylisted, robots-disallowed,
 * over-budget or self-reported URLs; every skip is a gap; every source card traces to a search event or the
 * instruction input; the job still finishes with a valid NKG.
 *
 * No network beyond 127.0.0.1, no real models, temp works/ and jobs/ dirs only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runJob, newJobState, STAGES } from "../src/job/runner.ts";
import { OPEN_FRAMES } from "../src/research/frames.ts";
import { validateNkg } from "../src/nkg/validate.ts";
import type { Claim } from "../src/research/claimTypes.ts";
import { createFetcher, normalizeUrl, sourceIdFor } from "../src/research/fetch/index.ts";
import { assertCardsTraceable } from "../src/research/search.ts";
import type { FetchDecision, Fetcher, ResearchGap, SourceCard } from "../src/research/types.ts";
import { readWork } from "../src/works/store.ts";
import { makeFakeModels } from "./e2e/fakeModels.ts";
import { INPUT_QUERY, PAGES, TITLE, startServer } from "./e2e/fixture.ts";

test("M1 gate (job e2e): denylist / robots / budget / self-reported URLs are never fetched and the job completes", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-job-e2e-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const worksDir = path.join(tmp, "works");
  const jobsDir = path.join(tmp, "jobs");
  fs.mkdirSync(worksDir, { recursive: true });

  const srv = await startServer();
  t.after(() => srv.close());
  const u = (p: string) => srv.base + p;

  // Every claim quote must really be in its page (guards the fixture itself).
  for (const page of Object.values(PAGES)) for (const c of page.claims) assert.ok(page.body.join("").includes(c.quote), `fixture quote "${c.quote}" in ${page.path}`);

  // Real fetcher, injected denylist; only allowPrivateAddresses is added (same budget object reference).
  const real = createFetcher({ denylist: { domains: [], patterns: [{ pattern: "/pirate/", reason: "e2e: pirate mirror" }] }, timeoutMs: 5_000 });
  const fetcher: Fetcher = { fetchAll: (candidates, ctx) => real.fetchAll(candidates, { ...ctx, allowPrivateAddresses: true }) };

  const models = makeFakeModels(srv.base);
  // searches: S0 1 + plot 0 + r1 2 + one r1 supplement call (budget 12 − used 3 − follow-up reserve 8 = 1) + gapfill 1.
  // AMENDMENT 12: the frame plan is opened (no caps / reserves) so this tiny budget exercises the fetch rules; the
  // post-NKG gapfill round (Haiku's missing M07) finds what the old follow-up r2 found.
  const limits = { searches: 12, fetches: 9, wallMs: 10 * 60_000 };
  const instructionUrl = u(PAGES.guide.path);
  const st = newJobState(
    { workQuery: INPUT_QUERY, mediumHint: null, rangeRaw: "全体", instructionUrls: [{ url: instructionUrl, note: "依頼者指定の読書ガイド" }], jobId: "e2e-0001" },
    new Date(),
    limits,
  );

  const t0 = Date.now();
  // S0–S2 only (the M1 gate path); S3 stages are covered by the gen tests.
  const done = await runJob(st, { luna: models.luna, haiku: models.haiku, fetcher, worksDir, jobsDir, until: "check", frames: OPEN_FRAMES });
  const elapsed = Date.now() - t0;

  // ---------------- job state
  const stageErrors = STAGES.slice(0, STAGES.indexOf("check") + 1).filter((s) => done.stages[s].status !== "done").map((s) => `${s}: ${done.stages[s].error}`);
  assert.deepEqual(stageErrors, [], `all stages done (job error: ${done.error})`);
  assert.equal(done.stages.check.status, "done"); // stopped after check (--until); not failed
  assert.notEqual(done.state, "failed");
  assert.equal(done.stages.check.metrics.nkg_valid, 1);
  assert.equal(done.stages.check.metrics.traceability_violations, 0);
  assert.ok(done.work_id);
  // CP-025: budget unit = page GETs issued by this job; three views must agree (state budget, fetch_log, server log).
  assert.equal(done.stages.check.metrics.fetch_gets_this_job, done.budget.fetchesUsed);
  assert.equal(done.stages.check.metrics.fetch_gets_consistent, 1);
  const pageRequests = srv.requests.filter((p) => p !== "/robots.txt").length;
  assert.equal(pageRequests, done.budget.fetchesUsed, "server page requests == budget.fetchesUsed");
  const workDir = path.join(worksDir, done.work_id);
  const readJ = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(workDir, rel), "utf8")) as T;

  // ---------------- fetch decisions
  const fetchLog = readJ<FetchDecision[]>("research/fetch_log.json");
  const decisionOf = (p: string) => fetchLog.filter((d) => d.url === u(p)).map((d) => d.decision);
  assert.deepEqual(decisionOf("/pirate/raw.html"), ["denylisted"]);
  assert.deepEqual(decisionOf("/private/secret.html"), ["robots_disallowed"]);
  assert.deepEqual(decisionOf("/missing.html"), ["http_error"]);
  assert.deepEqual(decisionOf("/cover.png"), ["unsupported_type"]);
  const overBudget = [PAGES.fan1.path, PAGES.fan2.path];
  for (const p of overBudget) assert.deepEqual(decisionOf(p), ["budget_exceeded"], p);
  const fetchedPaths = ["official", "library", "encyclopedia", "critic", "interview", "guide", "essay"].map((k) => PAGES[k].path);
  for (const p of fetchedPaths) assert.deepEqual(decisionOf(p), ["fetched"], p);

  // ---------------- what the server actually saw
  const seen = new Set(srv.requests);
  for (const p of ["/pirate/raw.html", "/private/secret.html", ...overBudget, models.selfReportedPath]) {
    assert.ok(!seen.has(p), `server must never receive ${p}`);
  }
  assert.ok(seen.has("/robots.txt"));
  for (const p of [...fetchedPaths, "/missing.html", "/cover.png"]) assert.ok(seen.has(p), `server received ${p}`);
  assert.equal(srv.requests.filter((p) => p === "/robots.txt").length, 1, "robots.txt fetched once (cached)");

  // ---------------- gaps
  const gaps = readJ<ResearchGap[]>("research/gaps.json");
  for (const d of fetchLog.filter((x) => x.decision !== "fetched" && x.decision !== "duplicate")) {
    const kinds = d.decision === "budget_exceeded" ? ["budget_exhausted"] : ["fetch_skipped"];
    assert.ok(gaps.some((g) => g.url === d.url && kinds.includes(g.kind)), `gap for skipped ${d.url} (${d.decision})`);
  }
  assert.ok(gaps.some((g) => g.kind === "self_reported_url" && g.url === u(models.selfReportedPath)), "self_reported_url gap");
  assert.ok(gaps.some((g) => g.kind === "coverage_shortfall" && g.aspect === "aspect:M07"), "M07 still short after the coverage rounds");
  const candidates = readJ<{ rejected: { url: string; reason: string }[] }>("research/candidates.json");
  assert.ok(candidates.rejected.some((r) => r.url === u(models.selfReportedPath) && r.reason === "self_reported"));

  // ---------------- source cards: traceable, origins limited to search events / instruction
  assert.deepEqual(assertCardsTraceable(workDir), []);
  assert.deepEqual(assertCardsTraceable(workDir, [instructionUrl]), []);
  const cards = readJ<SourceCard[]>("research/sources.json");
  assert.equal(cards.length, fetchedPaths.length);
  for (const c of cards) assert.ok(c.origin.kind === "search_event" || c.origin.kind === "instruction", `${c.url} origin ${c.origin.kind}`);
  const instrCards = cards.filter((c) => c.origin.kind === "instruction");
  assert.deepEqual(instrCards.map((c) => c.url), [normalizeUrl(instructionUrl)]);
  assert.ok(cards.every((c) => c.origin.kind === "instruction" || c.url !== normalizeUrl(instructionUrl)));

  // ---------------- claims: every page backs ≥1 active claim with a verbatim quote position
  const claims = readJ<Claim[]>("research/claims.json");
  assert.equal(claims.length, models.claimIds.size, "every emitted claim recorded");
  for (const [tag, id] of models.claimIds) {
    const c = claims.find((x) => x.claim_id === id);
    assert.ok(c && c.status === "active", `claim ${tag}=${id} active (${c?.drop_reason})`);
  }
  for (const card of cards) {
    const raw = fs.readFileSync(path.join(workDir, card.raw_text_path), "utf8");
    const backed = claims.filter((c) => c.status === "active" && c.evidence.some((e) => e.source_id === card.source_id));
    assert.ok(backed.length > 0, `${card.url} backs a claim`);
    const page = Object.values(PAGES).find((p) => normalizeUrl(u(p.path)) === card.url)!;
    for (const c of backed) for (const e of c.evidence.filter((x) => x.source_id === card.source_id)) {
      assert.ok(page.claims.some((pc) => raw.slice(e.offset, e.offset + e.length) === pc.quote), `evidence of ${c.claim_id} is a verbatim quote`);
    }
  }

  // ---------------- NKG
  const nkg = readJ<any>("nkg/nkg.json");
  const v = validateNkg(nkg);
  assert.equal(v.ok, true, v.errors.slice(0, 5).join(" | "));
  assert.ok(nkg.nodes.length >= 10 && nkg.edges.length >= 5, `nodes ${nkg.nodes.length} edges ${nkg.edges.length}`);
  for (const el of [...nkg.nodes, ...nkg.edges]) {
    assert.ok(el.meta?.provenance?.length > 0, `${el.id} has provenance`);
    assert.ok(el.meta?.confidence?.grade, `${el.id} has confidence grade`);
    assert.notEqual(el.meta.authored_by, el.meta.reviewed_by, `${el.id} author ≠ reviewer`);
    const ids = new Set(cards.map((c) => c.source_id));
    for (const p of el.meta.provenance) assert.ok(ids.has(p.source_id), `${el.id} provenance ${p.source_id} has a card`);
  }
  assert.ok(nkg.gaps.length > 0);
  assert.ok(nkg.gaps.some((g: any) => g.module === "M07" && g.reason === "insufficient_sources"), "M07 insufficient → gap");
  const enabled = nkg.work.module_selection.filter((m: any) => m.enabled).map((m: any) => m.module).sort();
  assert.deepEqual(enabled, ["M01", "M02", "M03", "M06", "M10", "M12"]);
  const ms = readJ<any>("nkg/module_selection.json");
  assert.deepEqual(ms.insufficient.map((i: any) => i.module), ["M07"]);
  // the NKG layers reference real claim ids (provenance locators are claim ids)
  const claimIdSet = new Set(claims.map((c) => c.claim_id));
  const locators = [...nkg.nodes, ...nkg.edges].flatMap((el: any) => el.meta.provenance.map((p: any) => p.locator));
  assert.ok(locators.some((l: string) => /^claim:c\d{4}$/.test(l) && claimIdSet.has(l.slice(6))), "provenance cites claim ids");

  // ---------------- work.json
  const work = readWork(workDir);
  assert.equal(work.title, TITLE);
  assert.equal(work.title_status, "confirmed");
  assert.ok(work.aliases.some((a) => a.text === INPUT_QUERY), `input "${INPUT_QUERY}" kept as alias`);
  for (const id of work.title_source_ids) assert.ok(cards.some((c) => c.source_id === id));

  // ---------------- budget
  const budget = readJ<{ fetchesUsed: number; searchesUsed: number }>("research/budget.json");
  assert.ok(done.budget.fetchesUsed <= limits.fetches, `fetches ${done.budget.fetchesUsed}/${limits.fetches}`);
  assert.ok(done.budget.searchesUsed <= limits.searches, `searches ${done.budget.searchesUsed}/${limits.searches}`);
  assert.equal(done.budget.fetchesUsed, limits.fetches, "budget fully used (over-budget pages exist)");
  assert.deepEqual([budget.fetchesUsed, budget.searchesUsed], [done.budget.fetchesUsed, done.budget.searchesUsed]);
  // pages that were GET-requested = fetches counted (robots.txt excluded)
  assert.equal(srv.requests.filter((p) => p !== "/robots.txt").length, done.budget.fetchesUsed);

  // ---------------- models were fake, routed by task
  assert.ok(models.calls.every((c) => c.port === "haiku" || c.req.tools === "web_search" || c.req.tools === "none"));
  const webTasks = [...new Set(models.calls.filter((c) => c.req.tools === "web_search").map((c) => c.req.task))];
  // followup rounds do not start here: the 10-minute test wall clock is below the reserve kept for the post-NKG round
  assert.deepEqual(webTasks, ["s0.identify.search", "s1.search.plot", "s1.search.r1", "s1.search.r1.supplement", "s1.gapfill.r1"]);
  assert.match(String(done.stages.followup.metrics.stopped), /^wall_clock/);
  assert.equal(done.stages.gapfill.metrics.new_active_after_review, 2);
  assert.equal(done.stages.refact.metrics.rebuilt, 1);
  // CP-029 finding a: the r1 supplement ran once (budget-limited), for the first uncovered aspect (M02; bibliographic is
  // covered by the S0 candidates), recorded as such; its pick (already fetched in r1) was not requested again but now
  // maps M02 to a source; the remaining aspects are a budget gap, not a failure
  const sr1 = done.stages.search_r1.metrics;
  assert.equal(sr1.supplement_calls, 1);
  assert.equal(sr1.supplement_searches, 1);
  assert.equal(sr1.supplement_fetched, 0);
  assert.ok(Number(sr1.aspects_uncovered_after) < Number(sr1.aspects_uncovered_before), `${sr1.aspects_uncovered_before} -> ${sr1.aspects_uncovered_after}`);
  const slog = readJ<{ task: string; supplement?: boolean; aspect?: string }[]>("research/search_log.json");
  assert.deepEqual(slog.filter((x) => x.supplement).map((x) => [x.task, x.aspect]), [["s1.search.r1.supplement", "M02"]]);
  assert.ok(gaps.some((g) => g.kind === "budget_exhausted" && g.detail.startsWith("search supplement skipped")), "skipped supplement aspects recorded as a gap");
  assert.deepEqual(decisionOf(PAGES.encyclopedia.path), ["fetched"], "supplement pick already fetched in r1 → not fetched again");
  assert.ok(elapsed < 60_000, `job took ${elapsed} ms`);
  // sanity: source ids are the fetcher's (sha256 of normalized URL)
  for (const c of cards) assert.equal(c.source_id, sourceIdFor(c.url));
});
