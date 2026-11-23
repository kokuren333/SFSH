import { loadInput, readSource } from './input.ts';
import { createOutput } from './output.ts';
import { html } from './html.ts';
import { tokensToCss } from './design/tokensCss.ts';
import type { DesignTokens } from './design/tokens-types.ts';
import { loadFigures } from './figure-adapter.ts';
import { compareReading } from './search-core.ts';
import { commonPages, creatorId, entrances, hasSubpage, indexBody, layout, rows, searchBody, subpages, subpageBody, topBody, workBody } from './templates.ts';
import type { Subpage } from './templates.ts';
import { aboutBody, policyBody, spoilersBody, takedownBody } from './pages.ts';

export async function buildSite(out: string, baseUrl?: string): Promise<number> {
  const { index, works, site } = loadInput();
  index.works.sort(compareReading);
  const tokens = JSON.parse(readSource('design/tokens.json')) as DesignTokens;
  const figures = await loadFigures();
  const write = createOutput(out), pages: { path: string; title: string }[] = [];
  const phase = !!readSource('client/phase.ts', true);
  const page = (path: string, title: string, body: ReturnType<typeof html>, script?: string, usePhase = false) => {
    pages.push({ path, title }); write(path, layout(site, path, title, body, script, usePhase && phase));
  };
  write('assets/site.css', tokensToCss(tokens) + readSource('styles/base.css') + readSource('styles/figures.css', true) + readSource('styles/cards.css', true) + readSource('design/theme.css', true));
  write('catalog.json', JSON.stringify(index.works, null, 2));
  write('robots.txt', 'User-agent: *\nAllow: /\n');
  write('.nojekyll', '');
  page('index.html', 'トップ', topBody(index));
  page('works/index.html', '作品索引', indexBody(index), 'sort');
  page('genres/index.html', 'ジャンル', entrances(index, 'genres', '../'));
  page('search/index.html', '作品検索', searchBody(index), 'search');
  // Common pages (WP-5.4): the same list feeds the footer links in every page.
  const common = { about: aboutBody(site, tokens), policy: policyBody(site), takedown: takedownBody(site), spoilers: spoilersBody() };
  for (const c of commonPages) page(`${c.dir}/index.html`, c.title, common[c.dir]);
  // GitHub Pages serves 404.html for a missing path at ANY depth: with a base URL its links are root-absolute
  // (the base URL's path, e.g. /REPOSITORY/), otherwise relative (local preview).
  const root404 = baseUrl ? new URL(baseUrl).pathname.replace(/\/?$/, '/') : './';
  pages.push({ path: '404.html', title: 'ページが見つかりません' });
  write('404.html', layout(site, '404.html', 'ページが見つかりません', html`<p>指定されたページはありません。</p><a href="${root404}works/">作品索引から探す</a>`, undefined, false, root404));
  for (const axis of ['genres', 'media'] as const) for (const v of index.vocab[axis]) {
    const items = index.works.filter(w => axis === 'media' ? w.medium === v.slug : w.genres.includes(v.slug));
    if (items.length) page(`${axis}/${v.slug}/index.html`, v.label, rows(items, '../../', index));
  }
  for (const name of [...new Set(index.works.flatMap(w => w.creators))].sort()) {
    page(`creators/${creatorId(name)}/index.html`, name, rows(index.works.filter(w => w.creators.includes(name)), '../../', index));
  }
  for (const work of [...works].sort((a, b) => compareReading(a.work, b.work))) {
    page(`works/${work.work.work_id}/index.html`, work.work.title, workBody(work, index, tokens));
    for (const sub of Object.keys(subpages) as Subpage[]) if (hasSubpage(work, sub)) {
      page(`works/${work.work.work_id}/${sub}/index.html`, `${work.work.title} — ${subpages[sub]}`, subpageBody(work, sub, tokens, figures), undefined, true);
    }
  }
  pages.push({ path: 'sitemap/index.html', title: 'サイトマップ' });
  pages.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  write('sitemap/index.html', layout(site, 'sitemap/index.html', 'サイトマップ', html`<ul>${pages.map(p => html`<li><a href="../${p.path === 'index.html' ? '' : p.path.replace(/index\.html$/, '')}">${p.title}</a></li>`)}</ul>`));
  if (baseUrl) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.search || base.hash || base.username || base.password) throw new Error('Invalid base URL');
    const root = base.href.replace(/\/$/, '') + '/';
    // XML tags use the same escaping boundary as HTML. The standard namespace is omitted.
    write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n' + html`<urlset>${pages.map(p => html`<url><loc>${root + p.path.replace(/index\.html$/, '')}</loc></url>`)}</urlset>`.__raw);
  }
  return pages.length;
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/site/src/build.ts')) {
  buildSite(process.argv[2]!, process.argv[3]).then(n => console.log(`pages=${n}`));
}
