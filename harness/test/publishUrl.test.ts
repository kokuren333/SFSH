/**
 * M6 (CP-049 residual 2): post-push URL check waits for the Pages deploy (cache-busted release-manifest.json equals the
 * new manifest) before it requests any canonical URL, so the check cannot make the CDN cache a pre-deploy 404.
 * Fake fetch only (no network).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../src/publish/repo.ts";
import { verifyUrl } from "../src/publish/url.ts";

const BASE = "https://pages.example.invalid/site/";
const oldManifest = Buffer.from('{"files":["old"]}');
const newManifest = Buffer.from('{"files":["new"]}');
const page = Buffer.from("<p>new work</p>");

function fakePages(deployAfterPolls: number) {
  const log: string[] = [];
  let sentinelPolls = 0;
  const deployed = () => sentinelPolls >= deployAfterPolls;
  const f = (async (input: URL | string) => {
    const u = new URL(String(input));
    log.push(u.pathname + u.search);
    const body = (b: Buffer | null) => new Response(b ? new Uint8Array(b) : "404", { status: b ? 200 : 404 });
    if (u.pathname.endsWith("/release-manifest.json")) {
      if (u.searchParams.has("sfsh-deploy")) sentinelPolls++;
      return body(deployed() ? newManifest : oldManifest);
    }
    if (u.pathname.endsWith("/works/new/index.html")) return body(deployed() ? page : null);
    return body(null);
  }) as typeof fetch;
  return { f, log };
}

test("deploy sentinel: canonical URLs are requested only after the cache-busted manifest is the new one", async () => {
  const { f, log } = fakePages(3);
  const r = await verifyUrl(BASE, [{ path: "works/new/index.html", sha256: sha256(page) }], { sha256: sha256(newManifest) }, {
    loopbackOnly: false, timeoutMs: 5_000, intervalMs: 1, fetchImpl: f, deploySentinel: { sha256: sha256(newManifest), tag: "R1" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.deploy?.ok, true);
  assert.equal(r.deploy?.polls, 3);
  const firstCanonical = log.findIndex((p) => !p.includes("sfsh-deploy="));
  assert.ok(firstCanonical >= 3, `no canonical request before the deploy was observed: ${log.join(" ")}`);
  assert.deepEqual(log.slice(0, 3), ["/site/release-manifest.json?sfsh-deploy=R1-1", "/site/release-manifest.json?sfsh-deploy=R1-2", "/site/release-manifest.json?sfsh-deploy=R1-3"]);
  assert.equal(r.attempts, 1, "one file pass after the deploy");
});

test("deploy sentinel: not deployed within the timeout → failed without requesting any canonical URL", async () => {
  const { f, log } = fakePages(Number.POSITIVE_INFINITY);
  const r = await verifyUrl(BASE, [{ path: "works/new/index.html", sha256: sha256(page) }], { sha256: sha256(newManifest) }, {
    loopbackOnly: false, timeoutMs: 30, intervalMs: 5, fetchImpl: f, deploySentinel: { sha256: sha256(newManifest), tag: "R2" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.deploy?.ok, false);
  assert.ok(log.length >= 1 && log.every((p) => p.includes("sfsh-deploy=")), log.join(" "));
  assert.match(r.missing.join(" "), /deploy not observed/);
});

test("without a sentinel the file check behaves as before (used by verify-url and the local test bare)", async () => {
  const { f } = fakePages(0);
  const r = await verifyUrl(BASE, [{ path: "works/new/index.html", sha256: sha256(page) }], null, { loopbackOnly: false, timeoutMs: 0, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.deploy, null);
});
