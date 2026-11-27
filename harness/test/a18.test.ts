import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixtures } from '../../site/fixtures/data.ts';
import { bookWorkBody, bookPageBody, bookSources } from '../../site/src/book.ts';
import { workBody, subpageBody } from '../../site/src/templates.ts';
import { sourceCards } from '../../site/src/sources.ts';
import type { PublicWork, SiteInputIndex } from '../../site/src/public-types.ts';
import type { DesignTokens } from '../../site/src/design/tokens-types.ts';

const tokens = JSON.parse(fs.readFileSync(new URL('../../site/src/design/tokens.json', import.meta.url), 'utf8')) as DesignTokens;
const index = { works: [], vocab: { media: [], genres: [], tags: [] } } as unknown as SiteInputIndex;
function book(kind: 'nonfiction' | 'mixed' = 'nonfiction'): PublicWork {
  const w = structuredClone(fixtures[0]!);
  w.work.kind = kind;
  w.work.selected_modules = ['B01', 'B07'];
  const sid = w.sources[0]!.source_id;
  w.book = {
    nodes: [{ id: 'thesis-a', type: 'Thesis', module: 'B01', label: '判断の条件', summary: '著者が扱う問いです。', stance: 'author_claim', section: null, grade: 'A', epistemic: 'canon', source_refs: [sid] }],
    edges: [],
    pages: [
      { slug: 'summary', label: '要旨（全編）', module: 'B00', blocks: [{ id: 'intro-a', heading: '本の問い', paragraphs: ['問いから結論へ進む要旨です。'], based_on: ['thesis-a'], stance: 'author_claim', epistemic: 'canon', spoiler: 'none' }] },
      { slug: 'thesis', label: '中心命題', module: 'B01', blocks: [{ id: 'claim-a', heading: '判断と制度', paragraphs: ['著者は制度が判断に影響すると論じます。', '次に、その条件を検討します。'], based_on: ['thesis-a'], stance: 'author_claim', epistemic: 'canon', spoiler: 'none' }] },
      { slug: 'criticism', label: '批判と反論', module: 'B07', blocks: [{ id: 'crit-a', heading: '留保', paragraphs: ['ここからはハーネスによる解釈です。'], based_on: ['thesis-a'], stance: 'harness_interpretation', epistemic: 'sfsh_analysis', spoiler: 'none' }] },
    ],
  };
  return w;
}

test('A18: nonfiction top is a complete static chaptered reading of selected prose, with stance separation', () => {
  const w = book(), before = JSON.stringify(w), body = bookWorkBody(w).__raw;
  assert.match(body, /<article class="book-reading"/);
  assert.match(body, /目次（全2章）/);
  assert.match(body, /第1章[\s\S]*中心命題[\s\S]*第2章[\s\S]*批判と反論/);
  assert.ok(body.indexOf('book-reading') < body.indexOf('nav-cards'));
  for (const p of w.book!.pages) for (const b of p.blocks) for (const para of b.paragraphs) assert.ok(body.includes(para), para);
  assert.match(body, /著者の主張/); assert.match(body, /出典で確認した事実/); assert.match(body, /ハーネスの解釈/);
  assert.doesNotMatch(body, /<table|book-connection|sources\/#|あらすじ|結末のネタバレ/);
  assert.equal(JSON.stringify(w), before, 'rendering preserves provenance, based_on and all content');
});

test('A18: unselected modules need no chapter, and an empty selected page creates no empty chapter', () => {
  const w = book(); w.book!.pages.push({ slug: 'open-questions', label: '未解決', module: 'B10', blocks: [] });
  const body = bookWorkBody(w).__raw;
  assert.match(body, /目次（全2章）/); assert.doesNotMatch(body, /id="reading-open-questions"|概念マップ/);
});

test('A18: mixed keeps the nonfiction reading and the fiction reading with unique anchors', () => {
  const w = book('mixed');
  const body = workBody(w, index, tokens).__raw;
  assert.match(body, /論考として読む/); assert.match(body, /物語として読む/);
  assert.match(body, /reading-thesis/); assert.match(body, /著者は制度/);
  const ids = [...body.matchAll(/\\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(body, /sources\/#/);
});

test('A18: source links are aggregated across nonfiction and fiction pages; source cards retain metadata and grades', () => {
  const w = book(), before = JSON.stringify(w);
  const body = bookPageBody(w, 'thesis').__raw;
  assert.doesNotMatch(body, /sources\/#/); assert.match(body, /class="source-summary"/);
  assert.equal((body.match(/href="\.\.\/sources\/"/g) ?? []).length, 1);
  const cards = bookSources(w).__raw;
  assert.match(cards, /根拠要素の信頼度: A/); assert.match(cards, /出典区分: T[1-5]/);
  for (const s of w.sources) { assert.ok(cards.includes(s.source_id)); assert.ok(cards.includes(s.accessed)); }
  assert.equal(JSON.stringify(w), before);
  const fiction = structuredClone(fixtures[0]!);
  assert.match(workBody(fiction, index, tokens).__raw, /class="source-summary"/);
  for (const page of ['themes', 'people', 'events', 'interpretations', 'quiz'] as const) {
    const rendered = subpageBody(fiction, page, tokens, null).__raw;
    assert.match(rendered, /class="source-summary"/); assert.doesNotMatch(rendered, /sources\/#/);
  }
  assert.match(subpageBody(fiction, 'sources', tokens, null).__raw, /根拠要素の信頼度/);
});

test('A18: chapter text and bibliography remain escaped', () => {
  const w = book(); w.book!.pages[1]!.blocks[0]!.paragraphs = ['<script>untrusted</script>'];
  w.sources[0]!.title = '<img onerror="untrusted">';
  assert.doesNotMatch(bookWorkBody(w).__raw, /<script>/);
  assert.match(bookWorkBody(w).__raw, /&lt;script&gt;/);
  assert.doesNotMatch(sourceCards(w).__raw, /<img /);
});
