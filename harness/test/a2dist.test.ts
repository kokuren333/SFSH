/** M3 WP-3.1 A-2(b) / WP-3.4: media contamination in the build output (scan → sanitize → rescan, build integration). */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyA2ToDist, mediaMagic, sanitizeCss, sanitizeDist, sanitizeMarkup, scanDist, scanJs, type DistA2Report } from "../src/check/dist.ts";
import { build, listFiles } from "../src/site/build.ts";
import { repoRoot } from "../src/site/stage.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "sfsh-a2d-"));
const fixtureOut = path.join(root, "fixture-dist");
const realOut = path.join(root, "real-dist");
let fixtureSummary: Awaited<ReturnType<typeof build>>;
let realSummary: Awaited<ReturnType<typeof build>>;

/** build() shares site/.input with other test files; retry once on a staging race (PLAN common rules). */
async function buildRetry(opts: Parameters<typeof build>[0]) {
  try {
    return await build(opts);
  } catch (e) {
    if (!/ENOENT|EBUSY|EPERM/.test(String((e as Error).message))) throw e;
    return await build(opts);
  }
}

before(async () => {
  fixtureSummary = await buildRetry({ worksDir: path.join(repoRoot, "site/fixtures/works"), out: fixtureOut, a2ReportPath: path.join(root, "a2_fixture.json") });
  realSummary = await buildRetry({ out: realOut, a2ReportPath: path.join(root, "a2_real.json") });
});
after(() => rmSync(root, { recursive: true, force: true }));

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, p));
    else out.push(p);
  }
  return out.sort();
}
const snapshot = (dir: string) => new Map(walk(dir).map((f) => [f, readFileSync(path.join(dir, f))] as const));

test("our renderer output has zero A-2 findings (fixture works and the real works/), and build() reports a2 counts", async () => {
  assert.deepEqual(fixtureSummary.a2, { detected: 0, removed: 0 });
  assert.deepEqual(realSummary.a2, { detected: 0, removed: 0 });
  assert.ok(realSummary.works >= 1);
  assert.deepEqual(scanDist(fixtureOut), []);
  assert.deepEqual(scanDist(realOut), []);
  const exts = new Set((await listFiles(realOut)).map((f) => path.extname(f) || f));
  for (const e of exts) assert.ok([".html", ".css", ".js", ".json", ".txt", ".nojekyll"].includes(e), `unexpected output type ${e}`);
  const html = (await listFiles(realOut)).filter((f) => f.endsWith(".html")).map((f) => readFileSync(path.join(realOut, f), "utf8")).join("\n");
  assert.ok(html.includes("<svg"), "real output contains inline figure SVGs (scanned, not flagged)");
  const rep = JSON.parse(readFileSync(path.join(root, "a2_real.json"), "utf8")) as DistA2Report;
  assert.equal(rep.schema, "sfsh-a2-dist/1");
  assert.equal(rep.detected.length, 0);
  assert.equal(rep.residual_after_fix, 0);
  assert.ok(rep.files_scanned > 10);
  // the manifest is written after A-2: it lists exactly the files left
  const manifest = JSON.parse(readFileSync(path.join(realOut, "release-manifest.json"), "utf8")) as { files: { path: string }[] };
  assert.deepEqual(manifest.files.map((f) => f.path), (await listFiles(realOut)).filter((f) => f !== "release-manifest.json"));
});

test("planted dist: every planted media item is detected (exact list) and removed; all other files byte-identical; rescan 0", () => {
  const dir = path.join(root, "planted");
  cpSync(fixtureOut, dir, { recursive: true });
  const orig = snapshot(dir);
  const files = [...orig.keys()];
  const page = files.find((f) => /^works\/[^/]+\/index\.html$/.test(f))!;
  const svgPage = files.find((f) => f.endsWith(".html") && orig.get(f)!.toString("utf8").includes("<svg "))!;
  assert.ok(page && svgPage && page !== svgPage, "fixture build has a work page and a page with an inline svg");
  const css = "assets/site.css";

  // binary media files (extension) and a PNG disguised as .txt (magic bytes)
  writeFileSync(path.join(dir, "assets/cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]));
  writeFileSync(path.join(dir, "assets/song.mp3"), Buffer.concat([Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000", "latin1"), Buffer.alloc(32)]));
  writeFileSync(path.join(dir, "assets/notes.txt"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
  // HTML page: hotlinked <img> and an <iframe> embed
  const pageText = orig.get(page)!.toString("utf8");
  const anchor = '<main class="text-column">';
  assert.ok(pageText.includes(anchor));
  writeFileSync(path.join(dir, page), pageText.replace(anchor, `${anchor}<img src="https://example.com/a.png" alt="x"><iframe src="https://www.youtube.com/embed/xyz" width="560"></iframe>`));
  // CSS background:url(...) inside an existing rule
  const cssText = orig.get(css)!.toString("utf8");
  const brace = cssText.indexOf("{");
  writeFileSync(path.join(dir, css), cssText.slice(0, brace + 1) + "background:url(https://example.com/bg.png);" + cssText.slice(brace + 1));
  // inline SVG <image href=...> inside an existing figure
  const svgText = orig.get(svgPage)!.toString("utf8");
  const svgOpen = svgText.indexOf(">", svgText.indexOf("<svg ")) + 1;
  writeFileSync(path.join(dir, svgPage), svgText.slice(0, svgOpen) + '<image href="https://example.com/i.png" width="10" height="10"/>' + svgText.slice(svgOpen));

  const found = scanDist(dir);
  const got = found.map((f) => `${f.file}|${f.kind}|${f.action}`).sort();
  const want = [
    "assets/cover.jpg|media_file|delete",
    "assets/song.mp3|media_file|delete",
    "assets/notes.txt|media_magic|delete",
    `${page}|html_media_tag|strip`,
    `${page}|html_media_tag|strip`,
    `${css}|css_url|strip`,
    `${svgPage}|svg_image|strip`,
  ].sort();
  assert.deepEqual(got, want);
  assert.ok(found.every((f) => /^[0-9a-f]{16}$/.test(f.sha256)));

  const res = sanitizeDist(dir, found);
  assert.deepEqual(res, { removed: 7, unremovable: [] });
  assert.deepEqual(scanDist(dir), []);
  const now = snapshot(dir);
  assert.deepEqual([...now.keys()], files, "planted files deleted, no other file added or removed");
  for (const f of files) assert.ok(now.get(f)!.equals(orig.get(f)!), `byte-identical after sanitize: ${f}`);
});

test("JS media cannot be removed safely → unremovable → applyA2ToDist throws (build failure path) and the report records it", () => {
  const dir = path.join(root, "js-case");
  cpSync(fixtureOut, dir, { recursive: true });
  writeFileSync(path.join(dir, "assets/evil.js"), 'const i = new Image(); i.src = "https://example.com/x.png";\ndocument.body.append(document.createElement("video"));\n');
  const found = scanDist(dir).filter((f) => f.file === "assets/evil.js");
  assert.deepEqual(found.map((f) => f.kind).sort(), ["js_media", "js_media", "media_url"]);
  assert.ok(found.every((f) => f.action === "unremovable"));
  const san = sanitizeDist(dir, found);
  assert.equal(san.unremovable.length, 3);
  assert.ok(existsSync(path.join(dir, "assets/evil.js")), "JS is never rewritten");
  const reportPath = path.join(root, "a2_js.json");
  assert.throws(() => applyA2ToDist(dir, reportPath), /A-2 \(dist\): 3 unremovable/);
  const rep = JSON.parse(readFileSync(reportPath, "utf8")) as DistA2Report;
  assert.equal(rep.unremovable.length, 3);
  assert.equal(rep.residual_after_fix, 3);
});

test("A-2(b) rule details: fragments and links are kept; srcset / style url / meta og:image / data URI attrs / external use / @import removed", () => {
  const keep = '<svg viewBox="0 0 1 1"><defs><marker id="m"/></defs><path marker-end="url(#m)" fill="url(#g)"/><use href="#m"/></svg><a href="https://e.com/photo.png">出典</a>';
  assert.deepEqual(sanitizeMarkup(keep), { out: keep, hits: [] });
  const cases: [string, string, string[]][] = [
    ['<p srcset="a.png 1x">t</p>', "<p>t</p>", ["srcset"]],
    ['<div style="color:red;background-image:url(x.webp)">t</div>', '<div style="color:red;">t</div>', ["css_url"]],
    ['<div style="background:url(x.webp)">t</div>', "<div>t</div>", ["css_url"]],
    ['<head><meta property="og:image" content="https://e.com/c.jpg"><title>t</title></head>', "<head><title>t</title></head>", ["html_media_tag"]],
    ['<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="a.css">', '<link rel="stylesheet" href="a.css">', ["html_media_tag"]],
    ['<a href="data:image/png;base64,AAAA">x</a>', "<a>x</a>", ["data_uri"]],
    ['<div data-src="https://e.com/lazy.jpg">x</div>', "<div>x</div>", ["media_url"]],
    ['<svg><use href="https://e.com/s.svg#i"/><foreignObject><p>x</p></foreignObject><feImage href="x.png"/></svg>', "<svg></svg>", ["svg_use_external", "svg_foreign_object", "svg_image"]],
    ["<video controls><source src=a.mp4><track src=a.vtt></video><p>本文</p>", "<p>本文</p>", ["html_media_tag"]],
    ['<input type="image" src="b.png"><input type="text">', '<input type="text">', ["html_media_tag"]],
    ["<style>.a{color:red;background:url(b.png)}</style>", "<style>.a{color:red;}</style>", ["css_url"]],
    ["<p>&lt;img src=x.png&gt; はただの文字</p>", "<p>&lt;img src=x.png&gt; はただの文字</p>", []],
  ];
  for (const [inp, out, kinds] of cases) {
    const r = sanitizeMarkup(inp);
    assert.equal(r.out, out, inp);
    assert.deepEqual(r.hits.map((h) => h.kind), kinds, inp);
  }
  assert.deepEqual(sanitizeMarkup("<script>new Image()</script>").hits.map((h) => [h.kind, h.action]), [["js_media", "unremovable"]]);
  // CSS
  assert.deepEqual(sanitizeCss(".a{fill:url(#g)}"), { out: ".a{fill:url(#g)}", hits: [] });
  assert.equal(sanitizeCss('@import url("https://fonts.example.com/x.css");.a{color:red}').out, ".a{color:red}");
  assert.equal(sanitizeCss('@import "local.css";.a{color:red}').out, '@import "local.css";.a{color:red}');
  assert.equal(sanitizeCss(".a{color:red; background: url('data:image/png;base64,AA;BB') no-repeat; margin:0}").out, ".a{color:red; margin:0}");
  assert.equal(sanitizeCss(".b{background-image:image-set('a.png' 1x)}").out, ".b{}");
  assert.equal(sanitizeCss("/* url(x.png) in a comment */.c{}").hits.length, 0);
  // JS
  assert.deepEqual(scanJs("const u = new URL(location.href); el.createElement('ol'); x.url('a');"), []);
  assert.equal(scanJs("el.innerHTML = '<img src=a>'").length, 1);
  // magic bytes
  const sig: [number[] | string, string][] = [
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], "png"],
    [[0xff, 0xd8, 0xff, 0xdb], "jpeg"],
    ["GIF89a....", "gif"],
    ["RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "webp"],
    ["RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "wave"],
    ["OggS\u0000\u0002", "ogg"],
    ["\u0000\u0000\u0000\u0018ftypmp42", "isobmff"],
    [[0x1a, 0x45, 0xdf, 0xa3, 0x01], "matroska"],
    ["fLaC\u0000", "flac"],
  ];
  for (const [b, name] of sig) assert.equal(mediaMagic(typeof b === "string" ? Buffer.from(b, "latin1") : Buffer.from(b)), name);
  for (const t of ["<!doctype html>", ":root{--a:1}", "{\"a\":1}", "User-agent: *", "export const a = 1;", ""]) assert.equal(mediaMagic(Buffer.from(t)), null, t);
});
