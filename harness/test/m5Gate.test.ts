/**
 * M5 gate (REQUIREMENTS 7.2 M5 + 7.4 M5, ledger CP-041): against a LOCAL test bare repository —
 *  1. publish: the bare holds only site files, exactly one commit, content = release-manifest.json; a second publish
 *     still leaves one commit; the Pages stand-in serves every manifest file with the right sha256.
 *  2. forbidden things planted in dist (secret-like string, Restricted work, disallowed extension, external reference,
 *     Restricted entry in catalog.json) stop the push — the bare and publish/ stay exactly as they were.
 *  3. takedown of a dummy work completes within 15 minutes (measured), the page is 404 on the stand-in, no title or
 *     alias remains in search data / index / genre lists / sitemaps, and after the bare's gc no object anywhere in
 *     its store holds the work (gone from history). purge additionally removes gen/ releases/ check/.
 * Temp dirs only.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishSite } from "../src/publish/index.ts";
import { makeTakedownHook } from "../src/publish/index.ts";
import { git, gitOut, lsTree } from "../src/publish/git.ts";
import { distTraces, purgeWork, takedownWork, workNeedles, MIN_NEEDLE_CHARS } from "../src/works/ops.ts";
import { readWork } from "../src/works/store.ts";
import { servePagesFromBare } from "../src/publish/url.ts";
import { bareCommitCount, bareRef, cleanFixtureDist, cleanupKit, dumpAllBlobs, makeKit, putDist, PUB_A, PUB_B, RESTRICTED, TEST_BASE } from "./publishKit.ts";

after(cleanupKit);

const LIST_PAGES = (files: string[]) =>
  files.filter((f) => f === "catalog.json" || f === "index.html" || f === "works/index.html" || f === "search/index.html" || f === "sitemap/index.html" || f === "sitemap.xml" || /^(genres|media|creators)\//.test(f));

test("publish to the local bare: site files only, one commit, manifest match; republish keeps one commit", async () => {
  const env = makeKit();
  const r1 = await publishSite(env, { trigger: "cli" });
  assert.equal(r1.status, "pushed", r1.error ?? "");
  assert.equal(r1.target?.kind, "test");
  assert.ok(r1.verify?.ok);
  assert.deepEqual(r1.verify?.public_set, [PUB_B, PUB_A].sort());
  const b = r1.post_verify.bare!;
  assert.ok(b.ok, b.problems.join("; "));
  assert.equal(b.commits_in_history, 1);
  assert.deepEqual(b.refs, ["refs/heads/main"]);
  assert.equal(b.non_site_files.length, 0);
  assert.equal(b.hash_mismatches.length, 0);
  assert.equal(b.files_in_repo, r1.verify!.files);
  assert.ok(r1.post_verify.url?.ok, "Pages stand-in serves every manifest file with the manifest sha256");
  // Repository content == dist exactly (independent re-check).
  const tree = lsTree(env.barePath, "refs/heads/main");
  const distFiles: string[] = [];
  const walk = (d: string, rel = "") => {
    for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(d, p);
      else distFiles.push(p);
    }
  };
  walk(env.distDir);
  assert.deepEqual([...tree.keys()].sort(), distFiles.sort());
  assert.ok(![...tree.keys()].some((p) => /^(harness|logs|design|queue|publish|site)\//.test(p) || /(^|\/)(nkg\.json|work\.json|INDEX\.json|LEDGER\.md|\.env)$/.test(p) || p.includes("research/")));
  // The commit has no parent, and its author is the neutral publisher identity.
  assert.equal(gitOut(["--git-dir", env.barePath, "log", "--format=%P|%an <%ae>", "-1", "main"]), "|SFSH publisher <sfsh-publisher@users.noreply.invalid>");
  // Release records for both works + run record + ledger line.
  for (const id of [PUB_A, PUB_B]) {
    const rel = path.join(env.worksDir, id, "releases", `${r1.release_id}.json`);
    const rec = JSON.parse(fs.readFileSync(rel, "utf8"));
    assert.equal(rec.work_id, id);
    assert.match(rec.content_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(rec.commit, r1.commit);
  }
  assert.ok(fs.existsSync(path.join(env.root, r1.record_path!)));
  assert.match(fs.readFileSync(env.ledgerPath, "utf8"), /- PUBLISH .* \| status=pushed \| trigger=cli .* target=test .* bare=ok\(commits=1/);

  // Second publish (no content change): still exactly one commit; no new work release records.
  const r2 = await publishSite(env, { trigger: "cli", noBuild: true });
  assert.equal(r2.status, "pushed", r2.error ?? "");
  assert.notEqual(r2.commit, r1.commit);
  assert.equal(bareCommitCount(env.barePath), 1);
  assert.equal(bareRef(env.barePath), r2.commit);
  assert.ok(r2.works.every((w) => !w.changed));
  // publish/ itself keeps only the snapshot (no reflog, no older commit reachable).
  assert.equal(Number(gitOut(["rev-list", "--all", "--count"], { cwd: env.publishDir })), 1);
});

test("forbidden things planted in dist stop the push (bare and publish/ unchanged)", async () => {
  const env = makeKit();
  const ok = await publishSite(env, { trigger: "cli" });
  assert.equal(ok.status, "pushed", ok.error ?? "");
  const before = bareRef(env.barePath);
  const publishHead = gitOut(["rev-parse", "HEAD"], { cwd: env.publishDir });
  const clean = path.join(env.root, "clean-dist");
  fs.cpSync(env.distDir, clean, { recursive: true });
  const restrictedTitle = readWork(path.join(env.worksDir, RESTRICTED)).title;
  const plants: { name: string; check: string; plant: (d: string) => void }[] = [
    { name: "secret-like token in JS", check: "c", plant: (d) => fs.appendFileSync(path.join(d, "assets", "search-core.js"), `\nconst t = "ghp_${"A1b2C3d4E5".repeat(3)}abcdef";\n`) },
    { name: "email address in a page", check: "c", plant: (d) => fs.appendFileSync(path.join(d, "about", "index.html"), "<p>owner@example.com</p>\n") },
    { name: "local path", check: "c", plant: (d) => fs.appendFileSync(path.join(d, "about", "index.html"), "<p>C:\\Users\\someone\\sfsh\\works</p>\n") },
    {
      name: "Restricted work page",
      check: "b",
      plant: (d) => {
        fs.mkdirSync(path.join(d, "works", RESTRICTED), { recursive: true });
        fs.writeFileSync(path.join(d, "works", RESTRICTED, "index.html"), "<!doctype html><p>x</p>\n");
      },
    },
    { name: "disallowed extension", check: "a", plant: (d) => fs.writeFileSync(path.join(d, "notes.md"), "# notes\n") },
    { name: "external script", check: "d", plant: (d) => fs.appendFileSync(path.join(d, "index.html"), '<script src="https://cdn.example.com/x.js"></script>\n') },
    { name: "external stylesheet import", check: "d", plant: (d) => fs.appendFileSync(path.join(d, "assets", "site.css"), "\n@import url(https://fonts.example.com/f.css);\n") },
    {
      name: "Restricted work in catalog.json",
      check: "g",
      plant: (d) => {
        const f = path.join(d, "catalog.json");
        const cat = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>[];
        cat.push({ ...cat[0], work_id: RESTRICTED, url: `works/${RESTRICTED}/`, title: restrictedTitle, aliases: [] });
        fs.writeFileSync(f, JSON.stringify(cat, null, 2));
      },
    },
  ];
  for (const p of plants) {
    putDist(env, clean);
    p.plant(env.distDir);
    const r = await publishSite(env, { trigger: "cli", noBuild: true });
    assert.equal(r.status, "blocked", `${p.name}: expected blocked`);
    assert.ok(r.verify && !r.verify.ok && r.verify.blocking.some((f) => f.check === p.check), `${p.name}: (${p.check}) finding expected; got ${JSON.stringify(r.verify?.blocking.map((f) => f.check + ":" + f.kind))}`);
    assert.equal(r.commit, null, `${p.name}: no commit`);
    assert.equal(r.remote_check, null, `${p.name}: stopped before touching publish/`);
    assert.equal(bareRef(env.barePath), before, `${p.name}: bare unchanged`);
    assert.equal(gitOut(["rev-parse", "HEAD"], { cwd: env.publishDir }), publishHead, `${p.name}: publish/ unchanged`);
    console.log(`# planted ${p.name}: blocked by (${p.check}) [${[...new Set(r.verify!.blocking.map((f) => `(${f.check}) ${f.kind}`))].join(", ")}]`);
  }
  assert.match(fs.readFileSync(env.ledgerPath, "utf8"), /status=blocked/);
});

test("takedown of a dummy work: ≤ 15 min, 404 on the stand-in, no title/alias in search/index/genres/sitemaps, gone from history", async () => {
  const env = makeKit();
  const first = await publishSite(env, { trigger: "cli" });
  assert.equal(first.status, "pushed", first.error ?? "");
  const all = workNeedles(env.worksDir, PUB_A);
  const needles = all.filter((n) => n.normalize("NFKC").trim().length >= MIN_NEEDLE_CHARS);
  // Before: the dummy work is visible in the published list pages.
  const listBefore = distTraces(env.distDir, needles).filter((t) => LIST_PAGES([t.file]).length);
  assert.ok(listBefore.some((t) => t.file === "catalog.json") && listBefore.some((t) => t.file === "works/index.html") && listBefore.some((t) => t.file === "sitemap.xml"));
  const srv0 = await servePagesFromBare(env.barePath, "main");
  try {
    assert.equal((await fetch(new URL(`works/${PUB_A}/`, srv0.url))).status, 200);
  } finally {
    await srv0.close();
  }

  const t0 = Date.now();
  const r = await takedownWork({
    worksDir: env.worksDir,
    workId: PUB_A,
    reason: "申し立て（M5 関門の試験）",
    jobsDir: env.jobsDir,
    ledgerPath: env.ledgerPath,
    buildOut: env.distDir,
    baseUrl: TEST_BASE,
    build: env.buildFn,
    publish: makeTakedownHook(env),
  });
  const elapsed = Date.now() - t0;
  console.log(`# takedown elapsed_ms=${elapsed} (local build ${Math.round(r.build.elapsed_ms)} ms); push: ${r.push}; 404: ${r.url_404_check}`);
  assert.ok(elapsed < 15 * 60_000, "within 15 minutes");
  assert.equal(r.publish_mode, "Restricted");
  assert.ok(r.publish?.ok, r.push);
  assert.match(r.push, /^pushed test /);
  assert.match(r.url_404_check, /^ok: .* → 404, catalog clean/);
  assert.equal(r.verification.traces.length, 0);

  // The bare's current tree: no trace of the work anywhere (in particular search data, indexes, genre lists, sitemaps).
  const head = path.join(env.root, "head-tree");
  const tree = lsTree(env.barePath, "refs/heads/main");
  for (const [p, oid] of tree) {
    fs.mkdirSync(path.dirname(path.join(head, p)), { recursive: true });
    fs.writeFileSync(path.join(head, p), git(["--git-dir", env.barePath, "cat-file", "blob", oid], { binary: true }).stdoutBuf);
  }
  const lists = LIST_PAGES([...tree.keys()]);
  assert.ok(lists.includes("catalog.json") && lists.includes("works/index.html") && lists.includes("sitemap.xml") && lists.includes("sitemap/index.html") && lists.some((f) => f.startsWith("genres/")));
  assert.deepEqual(distTraces(head, needles), [], "no title / alias / work_id anywhere in the published tree");
  assert.ok(![...tree.keys()].some((p) => p.startsWith(`works/${PUB_A}/`)));
  assert.ok([...tree.keys()].some((p) => p.startsWith(`works/${PUB_B}/`)), "other works stay published");

  // History: one commit; after gc nothing in the object store mentions the work.
  assert.equal(bareCommitCount(env.barePath), 1);
  git(["--git-dir", env.barePath, "reflog", "expire", "--expire=now", "--all"]);
  git(["--git-dir", env.barePath, "gc", "--prune=now", "--quiet"]);
  const objs = path.join(env.root, "all-objects");
  const n = dumpAllBlobs(env.barePath, objs);
  assert.ok(n > 10);
  assert.deepEqual(distTraces(objs, needles), [], "no blob in the bare's object store holds the work");
  const objsLocal = path.join(env.root, "all-objects-publish");
  dumpAllBlobs(path.join(env.publishDir, ".git"), objsLocal);
  assert.deepEqual(distTraces(objsLocal, needles), [], "publish/ keeps no object of the work either");

  // Records: work history + ledger lines (PUBLISH from the push side, OPS takedown with push/404 outcome).
  const w = readWork(path.join(env.worksDir, PUB_A));
  const h = w.history[w.history.length - 1]!;
  assert.equal(h.event, "takedown");
  assert.match(h.detail ?? "", /push pushed test .*url 404 check ok/);
  const ledger = fs.readFileSync(env.ledgerPath, "utf8");
  assert.match(ledger, /- PUBLISH .*status=pushed \| trigger=takedown .*404=ok\(404\)/);
  assert.match(ledger, /- OPS .* \| takedown \| work=novel-akari-2020 \| .*push pushed test/);
});

test("purge: takedown + push, gen/ releases/ check/ removed, research/ nkg/ work.json kept", async () => {
  const env = makeKit();
  const first = await publishSite(env, { trigger: "cli" });
  assert.equal(first.status, "pushed", first.error ?? "");
  const dir = path.join(env.worksDir, PUB_B);
  for (const sub of ["research", "nkg", "check"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, "research", "sources.json"), "[]\n");
  fs.writeFileSync(path.join(dir, "nkg", "nkg.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "check", "report.json"), "{}\n");
  assert.ok(fs.existsSync(path.join(dir, "releases", `${first.release_id}.json`)));
  const r = await purgeWork({ worksDir: env.worksDir, workId: PUB_B, reason: "完全消去（試験）", jobsDir: env.jobsDir, ledgerPath: env.ledgerPath, buildOut: env.distDir, baseUrl: TEST_BASE, build: env.buildFn, publish: makeTakedownHook(env) });
  assert.ok(r.publish?.ok, r.push);
  assert.deepEqual(r.deleted.sort(), ["check/", "gen/", "releases/"]);
  for (const k of ["research/", "nkg/", "work.json"]) assert.ok(r.kept.includes(k), k);
  const tree = lsTree(env.barePath, "refs/heads/main");
  assert.ok(![...tree.keys()].some((p) => p.startsWith(`works/${PUB_B}/`)));
  assert.equal(bareCommitCount(env.barePath), 1);
});

test("takedown without a publish target (publish/ not initialized) records the push as not run", async () => {
  const env = makeKit({}, false);
  putDist(env, await cleanFixtureDist());
  const hook = makeTakedownHook(env);
  assert.equal(hook, undefined);
  const r = await takedownWork({ worksDir: env.worksDir, workId: PUB_A, jobsDir: env.jobsDir, ledgerPath: env.ledgerPath, buildOut: env.distDir, baseUrl: TEST_BASE, build: env.buildFn, publish: hook });
  assert.match(r.push, /^not run: no publish target/);
  assert.equal(r.publish, null);
  assert.equal(fs.existsSync(env.barePath), false, "nothing created");
});

test("os tmp sanity: kit dirs are outside the repository", () => {
  const env = makeKit({}, false);
  assert.ok(env.root.startsWith(os.tmpdir()));
});

test("404.html: root-absolute links from the base URL path (Pages serves it at any depth); relative without a base URL", async () => {
  const { build } = await import("../src/site/build.ts");
  const env = makeKit({}, false);
  await build({ worksDir: env.worksDir, out: env.distDir, baseUrl: "https://account.github.io/repository/", a2ReportPath: path.join(env.root, "a2.json") });
  const page = fs.readFileSync(path.join(env.distDir, "404.html"), "utf8");
  assert.match(page, /<link rel="stylesheet" href="\/repository\/assets\/site\.css">/);
  assert.match(page, /href="\/repository\/works\/">作品索引から探す/);
  assert.ok(!/href="\.\.?\//.test(page), "no relative links in 404.html");
  const { verifyDist } = await import("../src/publish/verify.ts");
  assert.ok(verifyDist({ distDir: env.distDir, worksDir: env.worksDir }).ok, "root-absolute links are not external references");
  const local = path.join(env.root, "dist-local");
  await build({ worksDir: env.worksDir, out: local, a2ReportPath: path.join(env.root, "a2.json") });
  assert.match(fs.readFileSync(path.join(local, "404.html"), "utf8"), /href="\.\/assets\/site\.css"/);
});
