// WP-5.4: common site pages and the site settings contract (harness/config/site.json → site/.input/site.public.json).
// Builds go to OS temp dirs only (never works/, site/dist/ or the ledger) and serialize on the build lock.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { build, listFiles } from '../src/site/build.ts';
import { loadSiteSettings, repoRoot, siteSettingsPath } from '../src/site/stage.ts';
import { DEFAULT_SITE_SETTINGS, FALLBACK_SITE_NAME, validateSiteSettings } from '../../site/src/site-settings.ts';
import type { SiteSettings } from '../../site/src/site-settings.ts';

const worksDir = resolve(repoRoot, 'site/fixtures/works');
const COMMON = ['about', 'policy', 'takedown', 'spoilers'];
const ISSUES = 'https://github.com/example/example/issues';
const custom: SiteSettings = { site_name: 'テスト名', contact: { kind: 'issues', url: ISSUES } };
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const OPENING = 'Issues へのリンクは、サイトの開設時にこのページに掲示します。';
// After the opening (CP-048, U-10): the committed contact window is the Issues of the public site repository.
const OPENED_ISSUES = 'https://github.com/kokuren333/sfsh-site/issues';
let tmp: string, defOut: string, customOut: string, preOut: string, defFiles: string[], customFiles: string[], preFiles: string[], customA2 = -1;
const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8');

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'sfsh-site-pages-'));
  defOut = join(tmp, 'default'); customOut = join(tmp, 'custom'); preOut = join(tmp, 'pre-opening');
  // Default = harness/config/site.json (checked below to be the committed post-opening settings).
  await build({ worksDir, out: defOut, a2ReportPath: join(tmp, 'a2-default.json') });
  // The pre-opening code default (CP-041: no link yet) stays supported as an injected setting.
  await build({ worksDir, out: preOut, a2ReportPath: join(tmp, 'a2-pre.json'), site: DEFAULT_SITE_SETTINGS });
  preFiles = await listFiles(preOut);
  customA2 = (await build({ worksDir, out: customOut, a2ReportPath: join(tmp, 'a2-custom.json'), site: custom, baseUrl: 'https://example.invalid/project/' })).a2.detected;
  defFiles = await listFiles(defOut); customFiles = await listFiles(customOut);
});
after(async () => { if (tmp?.startsWith(tmpdir())) await rm(tmp, { recursive: true, force: true }); });

test('committed harness/config/site.json is the post-opening setting (CP-048): name undecided (U-14), window = sfsh-site Issues (U-10)', async () => {
  const opened = { site_name: null, contact: { kind: 'issues', url: OPENED_ISSUES } };
  assert.deepEqual(await loadSiteSettings(), opened);
  assert.deepEqual(JSON.parse(await readFile(siteSettingsPath, 'utf8')), opened);
  assert.deepEqual(DEFAULT_SITE_SETTINGS, { site_name: null, contact: { kind: 'issues', url: null } }, 'code default = pre-opening (no link)');
});

test('the four common pages exist, are static (no script), listed in the HTML sitemap, and sitemap.xml goes through the same list', async () => {
  for (const out of [defOut, customOut]) {
    const files = out === defOut ? defFiles : customFiles;
    const map = await read(out, 'sitemap/index.html');
    for (const dir of COMMON) {
      assert.ok(files.includes(`${dir}/index.html`), dir);
      const page = await read(out, `${dir}/index.html`);
      assert.doesNotMatch(page, /<script\b/, `${dir} must be readable without JS`);
      assert.ok(map.includes(`href="../${dir}/"`), `sitemap lists ${dir}`);
    }
  }
  const xml = await read(customOut, 'sitemap.xml');
  for (const dir of COMMON) assert.ok(xml.includes(`<loc>https://example.invalid/project/${dir}/</loc>`), `sitemap.xml lists ${dir}`);
  const about = await read(defOut, 'about/index.html');
  for (const label of ['確定設定', '一般的解釈', '考察', '独自分析', '情報不足', '出典']) assert.ok(about.includes(label), label);
  assert.doesNotMatch(about, /開設時に案内します/);
  const policy = await read(defOut, 'policy/index.html');
  for (const phrase of ['非公式', '引用もしません', '自作', '広告は載せません', 'アクセス解析', '検索エンジンへの登録は許可', 'まず該当するページを取り下げます']) assert.ok(policy.includes(phrase), phrase);
  const spoilers = await read(defOut, 'spoilers/index.html');
  for (const phrase of ['ネタバレなし', '中盤のネタバレ', '結末のネタバレ', '結末に触れる内容（クリックで表示）', '対象範囲']) assert.ok(spoilers.includes(phrase), phrase);
  const takedown = await read(defOut, 'takedown/index.html');
  for (const phrase of ['対象の作品名', '対象のページの URL', '取り下げを求める理由', '個人情報', '15分以内', '検索エンジンのキャッシュ']) assert.ok(takedown.includes(phrase), phrase);
});

test('committed settings: provisional name SFSH（仮称） in header and titles; takedown links the sfsh-site Issues; no other GitHub link', async () => {
  for (const path of defFiles.filter(p => p.endsWith('.html'))) {
    const page = await read(defOut, path);
    assert.ok(page.includes(`<a class="site-name" href="`) && page.includes(`">${FALLBACK_SITE_NAME}</a>`), path);
    assert.match(page, new RegExp(`<title>[^<]* \\| ${FALLBACK_SITE_NAME}</title>`), path);
    const gh = page.match(/<a href="https:\/\/github\.com[^"]*"/g) ?? [];
    assert.deepEqual(gh, path === 'takedown/index.html' ? [`<a href="${OPENED_ISSUES}"`] : [], path);
  }
  const takedown = await read(defOut, 'takedown/index.html');
  assert.ok(takedown.includes(`<a href="${OPENED_ISSUES}" rel="noopener">${OPENED_ISSUES}</a>`));
  assert.ok(!takedown.includes(OPENING));
});

test('pre-opening defaults (injected DEFAULT_SITE_SETTINGS): takedown says the link is posted at opening; no dead or GitHub link', async () => {
  for (const path of preFiles.filter(p => p.endsWith('.html'))) assert.ok(!(await read(preOut, path)).includes('<a href="https://github.com'), path);
  const takedown = await read(preOut, 'takedown/index.html');
  assert.ok(takedown.includes(OPENING));
  assert.doesNotMatch(takedown.replace(/<footer[\s\S]*$/, ''), /<a href="https?:/);
  assert.deepEqual(preFiles, defFiles, 'same file set as the committed-settings build');
});

test('injected settings: site name replaces the fallback everywhere, takedown links the Issues URL, nothing else changes structure', async () => {
  assert.equal(customA2, 0, 'the contact link is not an A-2 finding');
  for (const path of customFiles) assert.ok(!(await read(customOut, path)).includes(FALLBACK_SITE_NAME), `fallback name leaked into ${path}`);
  for (const path of customFiles.filter(p => p.endsWith('.html'))) {
    const page = await read(customOut, path);
    assert.ok(page.includes('">テスト名</a>'), path);
    assert.match(page, /<title>[^<]* \| テスト名<\/title>/, path);
  }
  assert.match(await read(customOut, 'about/index.html'), /<p>テスト名は、物語の構造を分析する非公式のサイトです。/);
  assert.match(await read(customOut, 'policy/index.html'), /<p>テスト名は非公式のサイトです。/);
  const takedown = await read(customOut, 'takedown/index.html');
  assert.ok(takedown.includes(`<a href="${ISSUES}" rel="noopener">${ISSUES}</a>`));
  assert.ok(!takedown.includes(OPENING));
  assert.deepEqual(customFiles.filter(p => p !== 'sitemap.xml'), defFiles, 'same file set as the default build (plus sitemap.xml from the base URL)');
});

test('no page in either build contains an email address', async () => {
  for (const [out, files] of [[defOut, defFiles], [customOut, customFiles]] as const) {
    for (const path of files) assert.doesNotMatch(await read(out, path), EMAIL, path);
  }
});

test('footer links (4 common pages + sitemap) resolve to existing files from every page depth; global nav keeps <= 5 items', async () => {
  for (const path of defFiles.filter(p => p.endsWith('.html'))) {
    const page = await read(defOut, path);
    const footer = /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(page)?.[1] ?? '';
    const hrefs = [...footer.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]!);
    assert.equal(hrefs.length, 5, path);
    const targets = hrefs.map(h => posix.normalize(posix.join(posix.dirname(path), h)).replace(/\/?$/, '/index.html').replace(/^\.\//, '').replace(/^\/index\.html$/, 'index.html'));
    assert.deepEqual(targets, [...COMMON, 'sitemap'].map(d => `${d}/index.html`), path);
    for (const t of targets) assert.ok(existsSync(join(defOut, t)), `${path} → ${t}`);
    for (const nav of page.matchAll(/<nav aria-label="グローバル">([\s\S]*?)<\/nav>/g)) assert.ok((nav[1]!.match(/<a /g) || []).length <= 5, path);
  }
});

test('invalid settings are rejected by validation and by the build (http URL, email-like text, markup, multi-line, long names, extra keys)', async () => {
  const bad: unknown[] = [
    { site_name: null, contact: { kind: 'issues', url: 'http://github.com/example/example/issues' } },
    { site_name: null, contact: { kind: 'issues', url: 'https://user:pw@github.com/example/example/issues' } },
    { site_name: null, contact: { kind: 'issues', url: 'https://github.com/example/example/issues?q=1' } },
    { site_name: null, contact: { kind: 'issues', url: 'https://github.com/example/example/issues#top' } },
    { site_name: null, contact: { kind: 'issues', url: 'javascript:alert(1)' } },
    { site_name: null, contact: { kind: 'mail', url: null } },
    { site_name: 'contact' + '@' + 'example.com', contact: { kind: 'issues', url: null } },
    { site_name: '<script>alert(1)</script>', contact: { kind: 'issues', url: null } },
    { site_name: '一行目\n二行目', contact: { kind: 'issues', url: null } },
    { site_name: 'あ'.repeat(41), contact: { kind: 'issues', url: null } },
    { site_name: '', contact: { kind: 'issues', url: null } },
    { site_name: null, contact: { kind: 'issues', url: null }, analytics: true },
    { site_name: null },
    null,
  ];
  for (const b of bad) assert.throws(() => validateSiteSettings(b), /Invalid site settings/, JSON.stringify(b));
  assert.deepEqual(validateSiteSettings(custom), custom);
  assert.equal(validateSiteSettings({ site_name: 'あ'.repeat(40), contact: { kind: 'issues', url: null } }).site_name, 'あ'.repeat(40));
  // The build stages (and validates) before deleting or writing the output: the rejected build leaves no output.
  for (const b of bad.slice(0, 1).concat(bad.slice(6, 8))) {
    const out = join(tmp, 'rejected');
    await assert.rejects(build({ worksDir, out, a2ReportPath: join(tmp, 'a2-rejected.json'), site: b as SiteSettings }), /Invalid site settings/);
    assert.ok(!existsSync(out));
  }
  // An invalid config file is a build error too (loadSiteSettings is the default source).
  const file = join(tmp, 'site.json');
  await writeFile(file, JSON.stringify({ site_name: null, contact: { kind: 'issues', url: 'http://example.invalid/issues' } }));
  await assert.rejects(loadSiteSettings(file), /must use https/);
});
