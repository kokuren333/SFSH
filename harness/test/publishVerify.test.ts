/**
 * WP-5.1 push-pre verification (a)–(g) (harness/src/publish/verify.ts). A clean dist is built ONCE from copied
 * fixture works (INDEX has a Restricted work and a Public work without gen/public.json); every planted case works
 * on its own copy. Temp dirs only — never touches the real works/, site/dist/ or logs/. build() uses the fixed
 * site/.input staging dir (serialized by a lock); if a concurrent build collides (ENOENT around site/.input), rerun.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "../src/site/build.ts";
import { repoRoot } from "../src/site/stage.ts";
import { publicSet, verifyDist, type CheckId, type VerifyReport } from "../src/publish/verify.ts";

const FIXTURES = path.join(repoRoot, "site", "fixtures", "works");
const R = "novel-restricted-1999";
const R_TITLE = "非公開専用の架空題名";
const R_ALIAS = "秘匿された別名テスト";
const MISSING = "game-missing-2001";
const P = ["anime-kumo-2021", "novel-akari-2020"];
const BASE_URL = "https://example.test/sfsh/";

let root = "";
let worksDir = "";
let clean = "";
let caseNo = 0;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-pverify-"));
  worksDir = path.join(root, "works");
  fs.cpSync(FIXTURES, worksDir, { recursive: true });
  // Give the Restricted work an alias (INDEX + work.json) so alias needles are exercised.
  const alias = { text: R_ALIAS, kind: "common", attested: true, source_ids: ["s1"], origin_job_id: "fixture", first_seen: "2026-01-02T00:00:00Z" };
  const idxFile = path.join(worksDir, "INDEX.json");
  const idx = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  idx.works.find((w: { work_id: string }) => w.work_id === R).aliases.push(alias);
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
  const wf = path.join(worksDir, R, "work.json");
  const w = JSON.parse(fs.readFileSync(wf, "utf8"));
  w.aliases.push(alias);
  fs.writeFileSync(wf, JSON.stringify(w, null, 2));
  clean = path.join(root, "clean");
  await build({ worksDir, out: clean, baseUrl: BASE_URL, a2ReportPath: path.join(root, "a2_clean.json") });
});
after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function copyClean(): string {
  const dir = path.join(root, "cases", String(++caseNo));
  fs.cpSync(clean, dir, { recursive: true });
  return dir;
}
function plant(fn: (dist: string) => void, opts: { previous?: { files: number; bytes: number } | null; allowEmails?: string[] } = {}): VerifyReport {
  const dist = copyClean();
  fn(dist);
  return verifyDist({ distDir: dist, worksDir, ...opts });
}
const read = (dist: string, rel: string) => fs.readFileSync(path.join(dist, rel), "utf8");
const write = (dist: string, rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
  fs.writeFileSync(path.join(dist, rel), content);
};
const append = (dist: string, rel: string, s: string) => write(dist, rel, read(dist, rel) + s);
const injectBody = (dist: string, rel: string, s: string) => write(dist, rel, read(dist, rel).replace("</body>", s + "</body>"));
const injectHead = (dist: string, rel: string, s: string) => write(dist, rel, read(dist, rel).replace("</head>", s + "</head>"));
function aJsFile(dist: string): string {
  const js = fs.readdirSync(path.join(dist, "assets"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js")).sort();
  assert.ok(js.length > 0, "the build emits client JS");
  return `assets/${js[0]!.replace(/\\/g, "/")}`;
}
function genrePage(dist: string): string {
  const g = fs.readdirSync(path.join(dist, "genres"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.ok(g.length > 0, "the build emits genre pages");
  return `genres/${g[0]}/index.html`;
}

function assertBlocked(r: VerifyReport, check: CheckId, kind?: string, file?: string): void {
  const hit = r.blocking.some((f) => f.check === check && (kind === undefined || f.kind === kind) && (file === undefined || f.file === file));
  assert.equal(r.ok, false, "report must not be ok");
  assert.ok(hit, `expected blocking (${check}${kind ? "/" + kind : ""}${file ? " @" + file : ""}); got ${JSON.stringify(r.blocking, null, 1)}`);
  assert.equal(r.checks[check].ok, false);
}
function assertNotVerbatim(r: VerifyReport, secret: string): void {
  assert.ok(!JSON.stringify(r).includes(secret), "secret must not appear verbatim in the report");
}

// ------------------------------------------------------------------ clean

test("clean fixture build: ok, zero blocking, Public set = INDEX Public with gen/public.json", () => {
  const r = verifyDist({ distDir: clean, worksDir, now: () => new Date("2026-11-23T00:00:00Z") });
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
  assert.equal(r.schema, "sfsh-publish-verify/1");
  assert.equal(r.checked_at, "2026-11-23T00:00:00.000Z");
  assert.deepEqual(r.public_set, P);
  assert.ok(r.files > 10 && r.bytes > 0);
  for (const c of ["a", "b", "c", "d", "e", "f", "g"] as CheckId[]) assert.deepEqual(r.checks[c], { ok: true, findings: 0 });
  assert.ok(fs.existsSync(path.join(clean, "sitemap.xml")), "sitemap.xml is part of the checked build");
});

test("publicSet: Restricted and Public-without-release are non-public, with needles", () => {
  const s = publicSet(worksDir);
  assert.deepEqual(s.public, P);
  const r = s.nonPublic.find((w) => w.work_id === R)!;
  assert.equal(r.publish_mode, "Restricted");
  assert.ok(r.needles.includes(R) && r.needles.includes(R_TITLE) && r.needles.includes(R_ALIAS));
  const m = s.nonPublic.find((w) => w.work_id === MISSING)!;
  assert.equal(m.publish_mode, "Public");
  assert.ok(m.needles.includes("生成前専用の架空題名"));
});

test("a non-P needle that is part of a P work's identifiers is dropped (shared alias)", () => {
  const wd = path.join(root, "works-shared");
  fs.cpSync(worksDir, wd, { recursive: true });
  const idxFile = path.join(wd, "INDEX.json");
  const idx = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  idx.works.find((w: { work_id: string }) => w.work_id === R).aliases.push({ text: "灯路", kind: "common", attested: true, source_ids: [], origin_job_id: "x", first_seen: "2026-01-02T00:00:00Z" });
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
  assert.ok(!publicSet(wd).nonPublic.find((w) => w.work_id === R)!.needles.includes("灯路"));
  assert.equal(verifyDist({ distDir: clean, worksDir: wd }).ok, true);
});

test("verifyDist writes nothing (dist and works unchanged)", () => {
  const snap = (dir: string) => {
    const h = createHash("sha256");
    for (const f of (fs.readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).sort()) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      h.update(f + "\0" + st.mtimeMs + "\0" + (st.isFile() ? fs.readFileSync(p).toString("base64") : "dir"));
    }
    return h.digest("hex");
  };
  const before = [snap(clean), snap(worksDir)];
  verifyDist({ distDir: clean, worksDir });
  assert.deepEqual([snap(clean), snap(worksDir)], before);
});

// ------------------------------------------------------------------ (c) secrets

const GH = "ghp_" + "x1Y2z3W4".repeat(4) + "Ab9Q";
const DISCORD = "MTIzNDU2Nzg5MDEyMzQ1Njc4" + "." + "GaBc1d" + "." + "Zx9_" + "abcDEF123".repeat(3);
const EMAIL = "someone.private@example.com";

test("(c) GitHub token in a JS file", () => {
  let js = "";
  const r = plant((d) => {
    js = aJsFile(d);
    append(d, js, `\nconst t = "${GH}";\n`);
  });
  assertBlocked(r, "c", "github_token", js);
  assertNotVerbatim(r, GH);
  const f = r.blocking.find((x) => x.kind === "github_token")!;
  assert.match(f.detail, /ghp_…[0-9a-f]{12}/);
});

test("(c) Discord bot token in a JSON file", () => {
  const r = plant((d) => write(d, "catalog-extra.json", JSON.stringify({ bot: DISCORD }) + "\n"));
  assertBlocked(r, "c", "discord_token", "catalog-extra.json");
  assertNotVerbatim(r, DISCORD);
});

test("(c) private key block in a txt file", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAexampleexampleexample\n-----END RSA PRIVATE KEY-----\n";
  const r = plant((d) => append(d, "robots.txt", key));
  assertBlocked(r, "c", "private_key", "robots.txt");
  assertNotVerbatim(r, "MIIEpAIBAAKCAQEAexampleexampleexample");
});

test("(c) other token shapes (AWS, sk-ant, sk-, Slack, Google, credential assignment)", () => {
  const cases: [string, string][] = [
    ["aws_access_key", "AKIA" + "ABCDEFGH23456789"],
    ["anthropic_key", "sk-ant-api03-" + "aB3dE5gH7jK9mN1pQ3sT"],
    ["api_key_sk", "sk-" + "aB3dE5gH7jK9mN1pQ3sTuV"],
    ["slack_token", "xoxb-" + "123456789012-abcdefABCDEF"],
    ["google_api_key", "AIza" + "SyA1234567890abcdefghijklmnopqrstuv"],
    ["credential_assignment", `api_key = "${"Zq8" + "w".repeat(14)}"`],
  ];
  for (const [kind, value] of cases) {
    const r = plant((d) => append(d, "robots.txt", `\n# ${value}\n`));
    assertBlocked(r, "c", kind, "robots.txt");
    assertNotVerbatim(r, value);
  }
});

test("(c) e-mail address in an HTML page (and the allowEmails exception)", () => {
  const r = plant((d) => injectBody(d, "about/index.html", `<p>${EMAIL}</p>`));
  assertBlocked(r, "c", "email", "about/index.html");
  assertNotVerbatim(r, EMAIL);
  const ok = plant((d) => injectBody(d, "about/index.html", `<p>${EMAIL}</p>`), { allowEmails: [EMAIL.toUpperCase()] });
  assert.equal(ok.ok, true, JSON.stringify(ok.blocking));
});

test("(c) entity-encoded e-mail is found after decoding", () => {
  const r = plant((d) => injectBody(d, "about/index.html", `<p>someone.private&#64;example.com</p>`));
  assertBlocked(r, "c", "email", "about/index.html");
});

test("(c) Windows local path C:\\Users\\…", () => {
  const p = "C:\\Users\\alice\\Documents\\notes.txt";
  const r = plant((d) => injectBody(d, "works/novel-akari-2020/index.html", `<p>${p}</p>`));
  assertBlocked(r, "c", "local_path_windows", "works/novel-akari-2020/index.html");
  assertNotVerbatim(r, "alice");
});

test("(c) Windows path escaped in JSON", () => {
  const r = plant((d) => write(d, "data.json", JSON.stringify({ p: "D:\\work\\secret" })));
  assertBlocked(r, "c", "local_path_windows", "data.json");
});

test("(c) unix home path /home/x/", () => {
  const r = plant((d) => append(d, "robots.txt", "# /home/x/notes\n"));
  assertBlocked(r, "c", "local_path_unix", "robots.txt");
});

test("(c) file:// URI", () => {
  const r = plant((d) => injectBody(d, "index.html", `<a href="file:///tmp/x">x</a>`));
  assertBlocked(r, "c", "file_uri", "index.html");
});

test("(c) the repository root absolute path (both slash styles)", () => {
  const abs = path.resolve(repoRoot);
  for (const form of [abs, abs.replace(/\\/g, "/")]) {
    const r = plant((d) => append(d, "assets/site.css", `\n/* built in ${form} */\n`));
    assertBlocked(r, "c", "repo_root_path", "assets/site.css");
    assertNotVerbatim(r, form);
  }
});

test("(c) ordinary URLs and a URL path containing /home/ are not local paths", () => {
  const r = plant((d) =>
    injectBody(d, "works/novel-akari-2020/sources/index.html", `<a href="https://zh.wikipedia.org/wiki/%E7%81%AF">a</a><a href="https://www.example.co.jp/home/index.html">b</a>`),
  );
  assert.equal(r.ok, true, JSON.stringify(r.blocking));
});

test("(c) minified-looking JS (base64 blobs, long dotted identifier chains) is not a token", () => {
  const b64 = Buffer.from("x".repeat(300) + "SFSH fixture payload " + "y".repeat(300)).toString("base64");
  const r = plant((d) =>
    append(
      d,
      aJsFile(d),
      `\nconst blob="${b64}";const z=Mabcdefghijklmnopqrstuvwx.abcdef.abcdefghijklmnopqrstuvwxyzabc;` +
        `const v="O${"A1b2".repeat(6)}"+".x";export{blob,z,v};\n`,
    ),
  );
  assert.ok(!r.blocking.some((f) => f.check === "c"), JSON.stringify(r.blocking));
});

// ------------------------------------------------------------------ (b) Restricted / non-public works

test("(b) a Restricted work's page dir works/<id>/index.html", () => {
  const r = plant((d) => write(d, `works/${R}/index.html`, "<!doctype html><title>x</title><p>x</p>"));
  assertBlocked(r, "b", "restricted_work", `works/${R}/`);
});

test("(b) the Restricted work_id inside a JS string", () => {
  let js = "";
  const r = plant((d) => {
    js = aJsFile(d);
    append(d, js, `\nexport const hidden = "${R}";\n`);
  });
  assertBlocked(r, "b", "restricted_work", js);
});

test("(b) a link to a non-public (no release) work is not_in_public_set", () => {
  const r = plant((d) => injectBody(d, "about/index.html", `<a href="../works/${MISSING}/">x</a>`));
  assertBlocked(r, "b", "not_in_public_set", "about/index.html");
});

test("(b) a work id that merely contains a non-P id as part of a longer P id is not flagged", () => {
  // novel-akari-2020 is P; a non-P id "akari-2020" (hypothetical) would be a substring of it.
  const wd = path.join(root, "works-substr");
  fs.cpSync(worksDir, wd, { recursive: true });
  const idxFile = path.join(wd, "INDEX.json");
  const idx = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  idx.works.push({ ...idx.works.find((w: { work_id: string }) => w.work_id === R), work_id: "akari-2020", title: "部分一致専用の題名", aliases: [] });
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
  assert.equal(verifyDist({ distDir: clean, worksDir: wd }).ok, true);
});

// ------------------------------------------------------------------ (a) file types

test("(a) disallowed files: .md, .map, .exe, no extension, .env, .git/HEAD", () => {
  const cases: [string, string, string][] = [
    ["notes.md", "# notes\n", "extension_not_allowed"],
    ["assets/app.js.map", '{"version":3}', "extension_not_allowed"],
    ["tool.exe", "MZ\u0000\u0000binary", "extension_not_allowed"],
    ["LICENSE", "text\n", "no_extension"],
    [".env", "X=1\n", "dotfile"],
    [".git/HEAD", "ref: refs/heads/main\n", "dot_directory"],
  ];
  for (const [rel, content, kind] of cases) {
    const r = plant((d) => write(d, rel, content));
    assertBlocked(r, "a", kind, kind === "dot_directory" ? ".git/" : rel);
  }
});

test("(a) other dotfiles and a nested .nojekyll block; uppercase allowed extensions pass", () => {
  assertBlocked(plant((d) => write(d, ".gitattributes", "* text\n")), "a", "dotfile", ".gitattributes");
  assertBlocked(plant((d) => write(d, "assets/.nojekyll", "")), "a", "dotfile", "assets/.nojekyll");
  const ok = plant((d) => write(d, "NOTE.TXT", "plain\n"));
  assert.equal(ok.ok, true, JSON.stringify(ok.blocking));
});

test("(a) symlinks block (skipped where symlinks cannot be created)", (t) => {
  const dist = copyClean();
  let rel = "link.txt";
  try {
    fs.symlinkSync(path.join(dist, "robots.txt"), path.join(dist, rel), "file");
  } catch {
    // Windows without the symlink privilege: a directory junction is a reparse point that lstat reports as a link.
    rel = "linkdir";
    try {
      fs.symlinkSync(path.join(dist, "assets"), path.join(dist, rel), "junction");
    } catch (e) {
      t.skip(`cannot create symlinks here (${(e as NodeJS.ErrnoException).code})`);
      return;
    }
  }
  const r = verifyDist({ distDir: dist, worksDir });
  assertBlocked(r, "a", "symlink", rel);
});

// ------------------------------------------------------------------ (d) external references

test("(d) external resource references", () => {
  const cases: [string, (d: string) => void, string][] = [
    ["script src", (d) => injectHead(d, "index.html", `<script src="https://cdn.example.com/lib.js"></script>`), "external_script"],
    ["link stylesheet //", (d) => injectHead(d, "index.html", `<link rel=stylesheet href="//cdn.example.com/x.css">`), "external_link"],
    ["css @import", (d) => write(d, "assets/site.css", `@import url(https://fonts.example.com/f.css);\n` + read(d, "assets/site.css")), "external_css_url"],
    ["css background url", (d) => append(d, "assets/site.css", `\nbody{background:url(http://img.example.com/bg)}\n`), "external_css_url"],
    ["iframe", (d) => injectBody(d, "index.html", `<iframe src=https://player.example.com/v/1></iframe>`), "external_attr"],
    ["svg use", (d) => injectBody(d, "index.html", `<svg><use href="https://sprites.example.com/s.svg#x"/></svg>`), "external_svg_href"],
    ["fetch in js", (d) => append(d, aJsFile(d), `\nfetch("https://api.example.com/v1/q");\n`), "external_js_url"],
    ["meta refresh", (d) => injectHead(d, "index.html", `<meta http-equiv="refresh" content="0; url=https://elsewhere.example.com/">`), "external_meta_refresh"],
    ["inline script url", (d) => injectBody(d, "index.html", `<script>navigator.sendBeacon("https://t.example.com/c")</script>`), "external_js_url"],
    ["inline style attr", (d) => injectBody(d, "index.html", `<div style="background-image:url('https://img.example.com/a')"></div>`), "external_css_url"],
    ["style element", (d) => injectHead(d, "index.html", `<style>@import "https://x.example.com/a.css";</style>`), "external_css_url"],
    ["form action", (d) => injectBody(d, "index.html", `<form action="https://collect.example.com/f"></form>`), "external_attr"],
    ["protocol-relative js", (d) => append(d, aJsFile(d), `\nconst u = "//cdn.example.com/x";\n`), "external_js_url"],
    ["entity-encoded src", (d) => injectHead(d, "index.html", `<script src="https&#58;//cdn.example.com/x.js"></script>`), "external_script"],
  ];
  for (const [name, fn, kind] of cases) {
    const r = plant(fn);
    assert.equal(r.ok, false, name);
    assert.ok(
      r.blocking.some((f) => f.check === "d" && f.kind === kind),
      `${name}: expected d/${kind}; got ${JSON.stringify(r.blocking)}`,
    );
  }
});

test("(d) plain external hyperlinks and JSON data URLs are not resources", () => {
  const r = plant((d) => {
    injectBody(d, "about/index.html", `<a href="https://example.org/page">x</a><map><area href="https://example.org/a" alt="a"></map>`);
    write(d, "data.json", JSON.stringify({ url: "https://example.org/x" }));
    injectBody(d, "index.html", `<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.org/"><text>x</text></a></svg>`);
  });
  assert.equal(r.ok, true, JSON.stringify(r.blocking));
});

// ------------------------------------------------------------------ (e) A-2

test("(e) A-2 media: <img src=a.png> and SVG <image>", () => {
  const img = plant((d) => injectBody(d, "index.html", `<img src="a.png" alt="">`));
  assertBlocked(img, "e", "a2_html_media_tag", "index.html");
  assert.ok(!img.blocking.some((f) => f.check === "d"), "a relative img is A-2, not an external ref");
  const svg = plant((d) => injectBody(d, "index.html", `<svg><image href="x.png" width="1" height="1"/></svg>`));
  assertBlocked(svg, "e", "a2_svg_image", "index.html");
});

// ------------------------------------------------------------------ (g) catalog and list pages

type Item = Record<string, unknown> & { work_id: string };
const editCatalog = (d: string, fn: (items: Item[]) => Item[]) => write(d, "catalog.json", JSON.stringify(fn(JSON.parse(read(d, "catalog.json")) as Item[]), null, 2));

test("(g) catalog.json with the Restricted work added", () => {
  const r = plant((d) => editCatalog(d, (items) => [...items, { ...items[0]!, work_id: R, url: `works/${R}/`, title: R_TITLE, aliases: [] }]));
  assertBlocked(r, "g", "catalog_restricted_work", "catalog.json");
  assertBlocked(r, "g", "non_public_trace", "catalog.json");
  assertBlocked(r, "b", "restricted_work", "catalog.json");
  assertNotVerbatim(r, R_TITLE);
});

test("(g) catalog.json with a Public work removed", () => {
  const r = plant((d) => editCatalog(d, (items) => items.filter((i) => i.work_id !== P[0])));
  assertBlocked(r, "g", "catalog_missing_work", "catalog.json");
});

test("(g) catalog item with an extra field (note)", () => {
  const r = plant((d) => editCatalog(d, (items) => items.map((i, k) => (k === 0 ? { ...i, note: "internal" } : i))));
  assertBlocked(r, "g", "catalog_field_not_allowed", "catalog.json");
});

test("(g) catalog title / alias / tag hitting (c)", () => {
  const r = plant((d) => editCatalog(d, (items) => items.map((i, k) => (k === 0 ? { ...i, aliases: [...(i.aliases as string[]), EMAIL] } : i))));
  assertBlocked(r, "g", "catalog_secret", "catalog.json");
  assertNotVerbatim(r, EMAIL);
});

test("(g) catalog.json missing / not an array / duplicate", () => {
  assertBlocked(plant((d) => fs.rmSync(path.join(d, "catalog.json"))), "g", "catalog_missing");
  assertBlocked(plant((d) => write(d, "catalog.json", "{}")), "g", "catalog_not_array");
  assertBlocked(plant((d) => write(d, "catalog.json", "[")), "g", "catalog_invalid_json");
  assertBlocked(plant((d) => editCatalog(d, (items) => [...items, items[0]!])), "g", "catalog_duplicate_work");
});

test("(g) Restricted title / alias text in a genre page and the sitemap page", () => {
  let g = "";
  const r1 = plant((d) => {
    g = genrePage(d);
    injectBody(d, g, `<p>${R_TITLE}</p>`);
  });
  assertBlocked(r1, "g", "non_public_trace", g);
  assertNotVerbatim(r1, R_TITLE);
  const r2 = plant((d) => injectBody(d, "sitemap/index.html", `<li>${R_ALIAS}</li>`));
  assertBlocked(r2, "g", "non_public_trace", "sitemap/index.html");
  assertNotVerbatim(r2, R_ALIAS);
  // NFKC: full-width / entity-encoded forms are found too.
  const r3 = plant((d) => injectBody(d, "search/index.html", `<p>${[...R_ALIAS].map((c) => `&#x${c.codePointAt(0)!.toString(16)};`).join("")}</p>`));
  assertBlocked(r3, "g", "non_public_trace", "search/index.html");
});

test("(g) works index must link every Public work; list pages only P", () => {
  const r = plant((d) => write(d, "works/index.html", read(d, "works/index.html").replace(new RegExp(`href="[^"]*${P[0]}/"`, "g"), 'href="#"')));
  assertBlocked(r, "g", "works_index_missing_work", "works/index.html");
  const x = plant((d) => write(d, "sitemap.xml", read(d, "sitemap.xml").replace("</urlset>", `<url><loc>${BASE_URL}works/${MISSING}/</loc></url></urlset>`)));
  assertBlocked(x, "g", "list_page_non_public_work", "sitemap.xml");
});

// ------------------------------------------------------------------ (f) growth

test("(f) growth is a warning only", () => {
  const r = plant(() => {}, { previous: { files: 10, bytes: 1000 } });
  assert.equal(r.ok, true, JSON.stringify(r.blocking));
  assert.deepEqual(r.blocking, []);
  assert.ok(r.warnings.some((w) => w.check === "f" && w.kind === "file_count_growth"));
  assert.equal(r.checks.f.ok, false);
  const big = plant((d) => write(d, "big.txt", "x".repeat(3 * 1024 * 1024)), { previous: { files: 1000, bytes: 1000 } });
  assert.equal(big.ok, true);
  assert.ok(big.warnings.some((w) => w.kind === "size_growth"));
  assert.ok(!big.warnings.some((w) => w.kind === "file_count_growth"));
  // > 50 % but small absolute growth: no warning.
  const small = verifyDist({ distDir: clean, worksDir, previous: { files: Math.max(1, Math.floor(r.files / 2)), bytes: r.bytes } });
  if (r.files - Math.floor(r.files / 2) <= 20) assert.deepEqual(small.warnings, []);
  assert.deepEqual(verifyDist({ distDir: clean, worksDir, previous: { files: r.files, bytes: r.bytes } }).warnings, []);
});

// ------------------------------------------------------------------ real data

test("real works/: a fresh temp build verifies clean", async (t) => {
  const real = path.join(repoRoot, "works");
  if (!fs.existsSync(path.join(real, "INDEX.json"))) {
    t.skip("works/INDEX.json missing");
    return;
  }
  const out = path.join(root, "real-dist");
  await build({ worksDir: real, out, baseUrl: BASE_URL, a2ReportPath: path.join(root, "a2_real.json") });
  const r = verifyDist({ distDir: out, worksDir: real });
  assert.deepEqual(r.blocking, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.public_set, publicSet(real).public);
});
