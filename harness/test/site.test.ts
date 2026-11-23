import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { request } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireBuildLock, build, listFiles, rendererArgs, run } from '../src/site/build.ts';
import { repoRoot, stageWorks } from '../src/site/stage.ts';
import { startPreviewServer } from '../src/site/preview.ts';
import { buildCommand, previewCommand } from '../src/commands/site.ts';
import { buildSite } from '../../site/src/build.ts';
import { readInput } from '../../site/src/input.ts';
import { createOutput } from '../../site/src/output.ts';
import { loadFigures, figure } from '../../site/src/figure-adapter.ts';
import type { FigureModule } from '../../site/src/figure-adapter.ts';
import type { CatalogItem } from '../../site/src/public-types.ts';
import type { DesignTokens } from '../../site/src/design/tokens-types.ts';
import { html } from '../../site/src/html.ts';
import { normalize, editDistance1Substring, rank, search, compareReading, readingGroup } from '../../site/src/search-core.ts';
import { filter, facets, parseState, stateParams } from '../../site/src/filter-core.ts';
import { fixtures, ledgers } from '../../site/fixtures/data.ts';

const workDir = resolve(repoRoot, 'site/fixtures/works');
const runDir = resolve(repoRoot, 'site/fixtures/.site-tests');
const outA = join(runDir, 'a'), outB = join(runDir, 'b');
let catalog: CatalogItem[];
let renderedFiles: string[];
before(async () => {
  await mkdir(runDir, { recursive: true });
  await build({ worksDir: workDir, out: outA });
  await build({ worksDir: workDir, out: outB });
  catalog = JSON.parse(await readFile(join(outA, 'catalog.json'), 'utf8'));
  renderedFiles = await listFiles(outA);
});
after(async () => {
  // Checked constant test directory under the fixture tree.
  assert.ok(runDir.startsWith(resolve(repoRoot, 'site/fixtures') + '\\') || runDir.startsWith(resolve(repoRoot, 'site/fixtures') + '/'));
  await rm(runDir, { recursive: true, force: true });
  await rm(resolve(repoRoot, 'site/fixtures/forbidden.json'), { force: true });
});
test('L0: only index.public.json and selected public.json files are staged; private works never reach output', async () => {
  // site/.input is shared with every other build: stage again under the build lock before listing (CP-032).
  const unlock = await acquireBuildLock();
  let staged: string[];
  try { await stageWorks(workDir); staged = await listFiles(resolve(repoRoot, 'site/.input')); } finally { await unlock(); }
  assert.deepEqual(staged, ['index.public.json', 'site.public.json', ...fixtures.map(w => `works/${w.work.work_id}/public.json`)].sort());
  for (const path of renderedFiles) {
    const text = await readFile(join(outA, path), 'utf8');
    for (const ledger of ledgers.slice(2)) { assert.ok(!text.includes(ledger.work_id), path); assert.ok(!text.includes(ledger.title), path); }
  }
  const unlock2 = await acquireBuildLock();
  let stagedData: Awaited<ReturnType<typeof stageWorks>>;
  try { stagedData = await stageWorks(workDir); } finally { await unlock2(); }
  assert.equal(stagedData.works.length, 2);
  assert.equal(stagedData.vocab.media.find(v => v.slug === 'anime')?.label, 'アニメ');
});
test('L1: renderer read/write imports are confined and has no networking/process APIs', async () => {
  const root = resolve(repoRoot, 'site/src');
  for (const path of await listFiles(root)) {
    if (!path.endsWith('.ts') || path.startsWith('client/')) continue;
    const text = await readFile(join(root, path), 'utf8');
    const fs = /(?:from\s*|import\s*\()\s*['"](?:node:)?fs(?:\/promises)?['"]/;
    if (fs.test(text)) assert.ok(['input.ts', 'output.ts'].includes(path), path);
    assert.doesNotMatch(text, /\bfetch\s*\(|node:(?:http|https|net|child_process)|['"]child_process['"]/, path);
    if (path !== 'input.ts') assert.doesNotMatch(text, /\b(?:readFileSync|readFile|readdirSync|readdir)\s*\(/, path);
    if (path !== 'output.ts') assert.doesNotMatch(text, /\b(?:writeFileSync|writeFile|mkdirSync|mkdir)\s*\(/, path);
  }
});
test('L2: renderer permission model denies the planted private read', async () => {
  await writeFile(resolve(repoRoot, 'site/fixtures/forbidden.json'), '{"private":"must not be read"}\n');
  const unlock = await acquireBuildLock();
  try { await stageWorks(workDir); await assert.rejects(run(process.execPath, rendererArgs(outA), { ...process.env, SFSH_TEST_FORBIDDEN: '1' }), /ERR_ACCESS_DENIED/); } finally { await unlock(); }
  assert.throws(() => readInput('../fixtures/forbidden.json'), /outside staged input/);
  assert.throws(() => createOutput(outA)('../escape.txt', 'x'), /outside output/);
});
test('determinism: two fresh permission-limited builds have identical files and hashes', async () => {
  assert.deepEqual(renderedFiles, await listFiles(outB));
  for (const path of renderedFiles) assert.deepEqual(await readFile(join(outA, path)), await readFile(join(outB, path)), path);
  const manifest = JSON.parse(await readFile(join(outA, 'release-manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
  assert.deepEqual(manifest.files.map(f => f.path), renderedFiles.filter(p => p !== 'release-manifest.json'));
  for (const f of manifest.files) assert.equal(f.sha256, createHash('sha256').update(await readFile(join(outA, f.path))).digest('hex'));
  assert.ok(!renderedFiles.includes('sitemap.xml'));
  assert.equal(await readFile(join(outA, '.nojekyll'), 'utf8'), '');
  assert.equal(await readFile(join(outA, 'robots.txt'), 'utf8'), 'User-agent: *\nAllow: /\n');
});
test('output has no external resources, images, iframe, CSS imports or CSS URLs; only bibliography links are external', async () => {
  for (const path of renderedFiles) {
    let text = await readFile(join(outA, path), 'utf8');
    assert.doesNotMatch(text, /<img\b|<iframe\b/i, path);
    if (path.endsWith('/sources/index.html')) {
      text = text.replace(/<a href="https?:\/\/[^"<>]*" rel="nofollow noopener">https?:\/\/[^<>]*<\/a>/g, '');
    }
    // Inline figure namespace declarations are allowed, never a resource request.
    text = text.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    assert.doesNotMatch(text, /https?:\/\/|(?:["'(=\s])\/\/[a-z0-9]/i, path);
    if (path.endsWith('.css')) assert.doesNotMatch(text, /@import|url\s*\(/i, path);
  }
});
test('markup is escaped; ending blocks are closed details; canonical title used on every work page', async () => {
  const text = await readFile(join(outA, 'works/novel-akari-2020/index.html'), 'utf8');
  assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;onload='));
  assert.doesNotMatch(text, /<script>alert|"onload=/);
  assert.match(text, /<details class="spoiler"><summary>結末に触れる内容（クリックで表示）<\/summary><section class="text-block" id="b2">/);
  assert.ok(text.includes('回想の詳細な順序'));
  assert.ok(text.includes('灯路')); assert.ok(!text.includes('あかりのこおろ'));
  assert.match(text, /根拠要素の信頼度: A/);
  const quiz = await readFile(join(outA, 'works/novel-akari-2020/quiz/index.html'), 'utf8');
  assert.match(quiz, /<h2>航路の選択を可能にしたのは何ですか。<\/h2>/);
  assert.match(quiz, /<details class="spoiler"><summary>結末に触れる内容（クリックで表示）<\/summary><p>地図の共有です。<\/p>/);
  for (const path of renderedFiles.filter(p => p.endsWith('.html'))) {
    const page = await readFile(join(outA, path), 'utf8');
    assert.ok(page.startsWith('<!doctype html>')); assert.ok(page.endsWith('\n'));
    assert.match(page, /<html lang="ja">/); assert.match(page, /content="width=device-width, initial-scale=1"/);
    assert.equal((page.match(/rel="stylesheet"/g) || []).length, 1);
    assert.match(page, /name="sfsh-root"/); assert.match(page, /非公式・独自分析サイト/);
    assert.doesNotMatch(page, /(?:href|src)="\//);
    if (path.startsWith('works/novel-akari-2020/')) assert.match(page, /<title>灯りの航路/);
  }
});
test('catalog fields match the allow-list exactly, use header values and contain all alias texts', () => {
  const keys = ['work_id', 'url', 'title', 'title_original', 'title_reading', 'aliases', 'medium', 'creators', 'genres', 'tags', 'status', 'first_release_year', 'coverage_label', 'spoiler_max', 'has_matrix', 'first_published_at', 'updated_at'].sort();
  assert.equal(catalog.length, 2);
  for (const item of catalog) assert.deepEqual(Object.keys(item).sort(), keys);
  assert.deepEqual(catalog[0]!.aliases, ['灯路', 'あかりのこおろ']);
  assert.deepEqual(catalog[0]!.creators, ['架空 葵']);
  assert.equal(catalog[0]!.title_reading, 'あかりのこうろ');
});
function item(changes: Partial<CatalogItem> = {}): CatalogItem {
  return { ...catalog[0]!, title: 'zzzz', title_reading: 'さ', aliases: [], creators: [], title_original: null, work_id: 'sample', ...changes };
}
test('search normalization, all eight ranking tiers, alias typos, kana, tie order and fuzzy substring threshold', () => {
  assert.equal(normalize(' ＡＢＣ・カタカナー！💡'), 'abcかたかな');
  const titles = ['abcd', 'abcdef', 'zzabcdzz', 'other3', 'other4', 'other5', 'other6', 'zzabxdzz'];
  const items = titles.map((title, i) => item({ work_id: 'id' + i, title, aliases: i === 3 ? ['abcd'] : i === 4 ? ['zzabcdzz'] : [], title_original: i === 5 ? 'abcd' : null, creators: i === 6 ? ['abcd'] : [] }));
  assert.deepEqual(items.map(i => rank(i, 'abcd')), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(search(items.reverse(), 'abcd').map(h => h.rank), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(search(catalog, 'あかりのこおろ')[0]?.item.title, '灯りの航路');
  assert.equal(search(catalog, 'あかりのこおろ')[0]?.alias, true);
  assert.equal(search(catalog, '灯路')[0]?.alias, true);
  assert.equal(search(catalog, 'くらうど')[0]?.item.title, 'クラウド工房');
  assert.equal(rank(item({ title_reading: 'カタカナ' }), 'かたかな'), 5);
  for (const target of ['zzabxdzz', 'zzabxcdzz', 'zzacdzz', 'zzabcdzz']) assert.ok(editDistance1Substring('abcd', target), target);
  assert.equal(rank(item({ title: 'abx' }), 'abc'), null);
  assert.equal(rank(item({ title: 'abxx' }), 'abcd'), null);
  assert.equal(search([item({ aliases: ['zzabxdzz'] })], 'abcd')[0]?.alias, true);
  const ties = [item({ work_id: 'z', title: 'xyB', title_reading: 'い' }), item({ work_id: 'b', title: 'xyA', title_reading: 'あ' }), item({ work_id: 'a', title: 'xyC', title_reading: 'あ' })];
  assert.deepEqual(search(ties, 'xy').map(h => h.item.work_id), ['a', 'b', 'z']);
  assert.deepEqual([item({ title: '1', title_reading: null }), item({ title: 'A', title_reading: null }), item({ title: 'あ', title_reading: null })].sort(compareReading).map(readingGroup), ['あ', 'A–Z', '0–9']);
});
test('search of 1,000 works stays below 100 ms per input', () => {
  const thousand = Array.from({ length: 1000 }, (_, n) => item({ work_id: String(n), title: `架空の物語${n}`, title_reading: `かくうのものがたり${n}`, aliases: ['通称物語' + n] }));
  search(thousand, '架空物語');
  for (const q of ['架空物語', '無関係文字列', 'ものがたり']) {
    const start = performance.now(); search(thousand, q); const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `${q}: ${elapsed.toFixed(2)} ms`);
    console.log(`search 1000 (${q}): ${elapsed.toFixed(2)} ms`);
  }
});
test('facets use same-axis OR and cross-axis AND; counts exclude own selection; URL state round trips', () => {
  const items = [item({ work_id: 'a', medium: 'novel', genres: ['mystery'], tags: ['city'], status: 'completed', first_release_year: 1995 }), item({ work_id: 'b', medium: 'anime', genres: ['sf'], tags: ['city'], has_matrix: false }), item({ work_id: 'c', medium: 'novel', genres: ['sf'], tags: ['space'], status: 'ongoing', has_matrix: false })];
  assert.equal(filter(items, { medium: ['novel', 'anime'] }).length, 3);
  assert.deepEqual(filter(items, { medium: ['novel'], genre: ['sf'] }).map(w => w.work_id), ['c']);
  const counts = facets(items, { medium: ['novel'], genre: ['mystery'] });
  assert.equal(counts.medium.find(o => o.value === 'anime')?.count, 0);
  assert.equal(counts.medium.find(o => o.value === 'anime')?.disabled, true);
  assert.equal(counts.genre.find(o => o.value === 'sf')?.count, 1);
  assert.equal(counts.decade.find(o => o.value === '1990')?.count, 1);
  assert.equal(facets(items.slice(0, 1), {}, items).medium.find(o => o.value === 'anime')?.disabled, true);
  const state = parseState(new URLSearchParams('q=灯り&medium=novel&genre=sf&genre=mystery&matrix=true&sort=updated'));
  assert.deepEqual(parseState(stateParams(state)), state);
  assert.equal(stateParams(state).getAll('genre').length, 2);
});
test('plain index links reach every staged work and HTML sitemap links to every page', async () => {
  const index = await readFile(join(outA, 'works/index.html'), 'utf8');
  const hrefs = [...index.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]!);
  for (const work of catalog) {
    const href = hrefs.find(h => h === '../' + work.url); assert.ok(href, work.work_id);
    assert.ok(renderedFiles.includes(new URL(href + 'index.html', 'https://local.invalid/works/').pathname.slice(1)));
  }
  const map = await readFile(join(outA, 'sitemap/index.html'), 'utf8');
  for (const path of renderedFiles.filter(p => p.endsWith('.html'))) assert.ok(map.includes('href="../' + path.replace(/index\.html$/, '') + '"'), path);
  assert.ok(!renderedFiles.includes('works/anime-kumo-2021/matrix/index.html'));
});
test('figure adapter supports missing module, real injected module, null output and unrelated failures', async () => {
  const missing = Object.assign(new Error('Cannot find module figures/index.ts'), { code: 'ERR_MODULE_NOT_FOUND', url: new URL('../../site/src/figures/index.ts', import.meta.url).href });
  assert.equal(await loadFigures(async () => { throw missing; }), null);
  const tokens = JSON.parse(await readFile(resolve(repoRoot, 'site/src/design/tokens.json'), 'utf8')) as DesignTokens;
  assert.equal(figure(fixtures[0]!, 'relations', tokens, null).__raw, '<p>この図は準備中です</p>');
  const module: FigureModule = { renderRelations: (viz, ctx) => html`<p>${ctx.workId} ${viz.characters[0]?.label}</p>`, renderReversePlot: () => null, renderMatrix: () => null };
  assert.match(figure(fixtures[0]!, 'relations', tokens, await loadFigures(async () => module)).__raw, /novel-akari-2020 灯守/);
  assert.match(figure(fixtures[0]!, 'reverse_plot', tokens, module).__raw, /情報不足/);
  await assert.rejects(loadFigures(async () => { throw new Error('broken figure'); }), /broken figure/);
  await assert.rejects(loadFigures(async () => { throw Object.assign(new Error('Cannot find package dependency imported from figures/index.ts'), { code: 'ERR_MODULE_NOT_FOUND' }); }), /dependency/);
  // Both import paths are also exercised by the renderer (the real module when available).
  assert.equal(typeof buildSite, 'function');
});
test('preview is loopback-only, uses index files/MIME/404, and rejects raw or encoded traversal', async () => {
  const server = await startPreviewServer({ dir: outA, port: 0 });
  const get = (path: string) => new Promise<{ status: number; text: string; type: string }>((ok, fail) => {
    const req = request(server.url + '/', { path }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', b => text += b); response.on('end', () => ok({ status: response.statusCode!, text, type: String(response.headers['content-type']) }));
    }); req.on('error', fail); req.end();
  });
  try {
    assert.ok(server.url.startsWith('http://127.0.0.1:'));
    assert.equal((await get('/')).status, 200);
    assert.match((await get('/')).text, /新着/);
    assert.match((await get('/assets/site.css')).type, /^text\/css/);
    assert.match((await get('/assets/client/search.js')).type, /^text\/javascript/);
    assert.match((await get('/catalog.json')).type, /^application\/json/);
    const missing = await get('/unknown/'); assert.equal(missing.status, 404); assert.match(missing.text, /ページが見つかりません/);
    assert.equal((await get('/../INDEX.json')).status, 400);
    assert.equal((await get('/%2e%2e/INDEX.json')).status, 400);
    assert.equal((await get('/%5c..%5cINDEX.json')).status, 400);
  } finally { await server.close(); }
});
test('raw() audit: no template call sites; shared html.ts declares the only raw function', async () => {
  const sites: string[] = [];
  for (const path of await listFiles(resolve(repoRoot, 'site/src'))) {
    if (!path.endsWith('.ts') || path.startsWith('figures/')) continue;
    const text = await readFile(resolve(repoRoot, 'site/src', path), 'utf8');
    for (const [i, line] of text.split('\n').entries()) if (/\braw\(/.test(line) && !/^\s*\*/.test(line)) sites.push(`${path}:${i + 1}:${line.trim()}`);
  }
  assert.equal(sites.length, 1);
  assert.match(sites[0]!, /^html\.ts:\d+:export function raw\(s: string\): Raw \{$/);
});
test('base CSS stays token-based; client compiles locally with LF modules and no source maps', async () => {
  const css = await readFile(resolve(repoRoot, 'site/src/styles/base.css'), 'utf8');
  assert.doesNotMatch(css.replace(/@media \(min-width: (?:600|1024)px\)/g, ''), /\d+(?:px|ms)|#[0-9a-f]{3}|\b(?:rgb|hsl)a?\(/i);
  assert.doesNotMatch(css, /gradient|shadow|italic|background-image|animation:/i);
  for (const path of renderedFiles.filter(p => p.endsWith('.js'))) {
    const text = await readFile(join(outA, path), 'utf8'); assert.ok(!text.includes('\r')); assert.doesNotMatch(text, /from\s+['"][^'"]+\.ts['"]/);
  }
});
test('CLI validates options; build refuses destructive source outputs', async () => {
  assert.equal(await buildCommand(['--wat', 'x']), 2);
  assert.equal(await previewCommand(['--port', 'bad']), 2);
  for (const out of [repoRoot, workDir, resolve(repoRoot, 'site/src'), resolve(repoRoot, 'harness')]) await assert.rejects(build({ worksDir: workDir, out }), /Unsafe output/);
});
test('base URL opt-in generates absolute sitemap loc entries and preserves project prefix', async () => {
  const out = join(runDir, 'with-map'); await mkdir(out, { recursive: true });
  const unlock = await acquireBuildLock();
  try { await stageWorks(workDir); await run(process.execPath, rendererArgs(out, 'https://example.invalid/project/')); } finally { await unlock(); }
  const xml = await readFile(join(out, 'sitemap.xml'), 'utf8');
  assert.match(xml, /<loc>https:\/\/example.invalid\/project\/works\/novel-akari-2020\/<\/loc>/);
  assert.doesNotMatch(xml, /index\.html/);
});
test('CP-026: people/events pages are emitted only with content, reachable by plain links and breadcrumbs, and listed in the sitemap', async () => {
  const work = await readFile(join(outA, 'works/novel-akari-2020/index.html'), 'utf8');
  assert.ok(work.includes('<a href="people/">人物と動機・変容</a>'));
  assert.ok(work.includes('<a href="events/">出来事と因果・世界のルール・伏線</a>'));
  for (const sub of ['people', 'events']) {
    const path = `works/novel-akari-2020/${sub}/index.html`;
    assert.ok(renderedFiles.includes(path), path);
    assert.ok(!renderedFiles.includes(`works/anime-kumo-2021/${sub}/index.html`), 'empty page omitted');
    const page = await readFile(join(outA, path), 'utf8');
    assert.match(page, /<nav class="breadcrumbs" aria-label="パンくず"><a href="..\/..\/..\/">トップ<\/a> › <a href="..\/..\/..\/works\/">作品索引<\/a> › <a href="..\/">灯りの航路<\/a> › /);
    assert.doesNotMatch(page, /<table\b|<svg\b/, 'lists, not figures');
  }
  const empty = await readFile(join(outA, 'works/anime-kumo-2021/index.html'), 'utf8');
  assert.doesNotMatch(empty, /href="(?:people|events)\/"/);
  const map = await readFile(join(outA, 'sitemap/index.html'), 'utf8');
  assert.ok(map.includes('href="../works/novel-akari-2020/people/"') && map.includes('href="../works/novel-akari-2020/events/"'));
});
test('CP-026: every element shows mark + label + grade; spoilers folded/labelled like other pages, including references; text escaped', async () => {
  const people = await readFile(join(outA, 'works/novel-akari-2020/people/index.html'), 'utf8');
  const events = await readFile(join(outA, 'works/novel-akari-2020/events/index.html'), 'utf8');
  for (const page of [people, events]) {
    const n = (page.match(/<section class="element"/g) || []).length;
    assert.ok(n > 0);
    assert.equal((page.match(/<section class="element" id="el-[^"]+"><h[34]>[^<]+<\/h[34]><span class="epistemic ep-[a-z_]+">\S+ [^<·]+ · 信頼度 [A-D]<\/span>/g) || []).length, n);
  }
  // people: prominence order, faction label, motive fields, analysis, arc, references
  assert.ok(people.indexOf('<h2>灯守</h2>') < people.indexOf('<h2>旅人</h2>'));
  assert.ok(people.includes('<p class="element-meta">所属: 灯台の家</p>'));
  assert.ok(people.includes('<h3>目標: 航路を守りたい</h3>') && people.includes('期間: 出発〜到着') && people.includes('<h3>恐れ: 道を失う恐れ</h3>'));
  assert.ok(people.includes('<div class="analysis"><p class="analysis-label"><span class="epistemic ep-sfsh_analysis">◆ 独自分析</span></p><p>守ることが閉ざすことと紙一重である点が、変容の起点になる。</p></div>'));
  assert.ok(people.includes('<p class="ref-title">動かした出来事</p><ul class="ref-list"><li><a href="../events/#el-e1">出港</a></li></ul><details class="spoiler"><summary>結末に触れる内容（クリックで表示）</summary><ul class="ref-list"><li><a href="../events/#el-e3">新しい航路の決定</a></li></ul></details>'), 'ending reference folded inside a non-ending motive');
  assert.ok(people.includes('<p class="ref-title">対立する動機</p><ul class="ref-list"><li><a href="#el-m2">道を失う恐れ</a>（旅人）</li></ul>'));
  assert.ok(people.includes('<details class="spoiler"><summary>結末に触れる内容（クリックで表示）</summary><section class="element" id="el-a1"><h3>変容: 独占から共有へ</h3>'));
  assert.ok(people.includes('<p class="arc-change">灯りの知識を一人で抱える → 知識を旅人と分け合う</p>'));
  assert.ok(people.includes('<a href="../events/#el-e2">地図の交換</a> <span class="spoiler-label">中盤のネタバレ</span>'), 'mid reference labelled in a none container');
  assert.ok(people.includes('<p>&lt;img src=x onerror=alert(2)&gt; &amp; 安全性検査'));
  assert.doesNotMatch(people, /<img\b|onerror=alert\(2\)>/);
  // events: story order (null last), cause/effect kinds, rules, setups, beats by phase with textual intensity
  const at = (id: string) => events.indexOf(`id="el-${id}"`);
  assert.ok(at('e1') < at('e2') && at('e2') < at('e3') && at('e3') < at('e4') && at('e4') < at('w1') && at('w1') < at('su1') && at('su1') < at('eb1') && at('eb1') < at('eb2'));
  assert.ok(events.includes('<p class="ref-title">原因</p><ul class="ref-list"><li><a href="#el-e2">地図の交換</a>（可能にする）</li><li><a href="#el-e4">嵐の接近</a>（妨げる）</li></ul>'));
  assert.ok(events.includes('<p class="ref-title">結果</p><ul class="ref-list"><li><a href="#el-e2">地図の交換</a>（引き起こす） <span class="spoiler-label">中盤のネタバレ</span></li></ul>'));
  assert.ok(events.includes('<details class="spoiler"><summary>結末に触れる内容（クリックで表示）</summary><section class="element" id="el-e3">'));
  assert.ok(events.includes('<p class="element-meta">フェーズ不明</p>'));
  assert.ok(events.includes('<h3>制約: 灯台の掟</h3>') && events.includes('<p>帰結: 夜の航路は灯守の許可なく使えない。</p>') && events.includes('<li><a href="#el-e1">出港</a></li><li>旅人</li>'));
  assert.ok(events.includes('<p class="spoiler-label">中盤のネタバレ</p><section class="element" id="el-su1"><h3>古い地図の余白</h3>'));
  assert.ok(events.includes('<h2>感情の起伏</h2><h3>出発</h3>') && events.includes('<p class="element-meta">感情: 不安 · 強さ 3/5</p>') && events.includes('<h3>到着</h3><details class="spoiler">'));
});
test('CP-026: analysis on themes, context, iconic and reverse-plot list; faction labels in the relations table; long text wraps', async () => {
  const label = '<p class="analysis-label"><span class="epistemic ep-sfsh_analysis">◆ 独自分析</span></p>';
  const themes = await readFile(join(outA, 'works/novel-akari-2020/themes/index.html'), 'utf8');
  assert.ok(themes.includes(`<div class="analysis">${label}<p>共有は自由を減らすのではなく、責任を分け合う形として描かれる。</p></div>`));
  const context = await readFile(join(outA, 'works/novel-akari-2020/context/index.html'), 'utf8');
  assert.equal((context.match(/<div class="analysis">/g) || []).length, 1, 'null analysis renders nothing');
  assert.match(context, /<details class="spoiler"><summary>結末に触れる内容（クリックで表示）<\/summary><section><h2>地図の交換<\/h2>[\s\S]*<div class="analysis">/);
  if (await loadFigures()) {
    const plot = await readFile(join(outA, 'works/novel-akari-2020/reverse-plot/index.html'), 'utf8');
    assert.ok(plot.includes('<p class="fig-b__summary">合意が選択を支える。</p><p class="fig-b__analysis">'));
    assert.ok(plot.includes('選択の背後には、知識を独占しないという約束が読み取れる。'));
    const rel = await readFile(join(outA, 'works/novel-akari-2020/relations/index.html'), 'utf8');
    assert.ok(rel.includes('<td>灯台の家</td>'));
  }
  const css = await readFile(resolve(repoRoot, 'site/src/styles/base.css'), 'utf8');
  assert.match(css, /body \{[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /white-space:\s*nowrap|overflow-x:\s*(?:scroll|visible)/);
  const people = await readFile(join(outA, 'works/novel-akari-2020/people/index.html'), 'utf8');
  assert.match(people, /<p>[^<]*A{80,}<\/p>/, 'long unbroken text stays in a wrapping paragraph');
  const doc = await readFile(resolve(repoRoot, 'site/src/design/CLASSES.md'), 'utf8');
  for (const cls of ['page-lead', 'person', 'element', 'element-meta', 'arc-change', 'ref-group', 'ref-title', 'ref-list', 'analysis', 'analysis-label']) assert.ok(doc.includes('`' + cls + '`'), cls);
});
