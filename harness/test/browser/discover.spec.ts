/**
 * T08 JS disabled: /works/ -> every work page by plain links; A phase switch via radio + :has()
 * T09 search: title / reading / every alias puts the work first; < 100 ms per input; 0-result links; ?q= round trip
 * T10 filters: same-axis OR, cross-axis AND, counts, zero-count disabled, URL reflected, restored on reload and resize
 * T11 state retention (search): query and filters survive 360 <-> 1280
 */
import type { Page } from '@playwright/test';
import { test, expect, manifest, open, url, guardContext, round, settle } from './lib.ts';
import { readFigA } from './probes.ts';

type Item = Record<string, any>;
const AXES = ['medium', 'genre', 'tag', 'status', 'decade', 'matrix'] as const;
type Axis = typeof AXES[number];
type Sel = Partial<Record<Axis, string[]>>;
/** Test oracle (REQUIREMENTS 6.5: same axis OR, axes AND, counts exclude their own axis). */
function vals(it: Item, axis: Axis): string[] {
  switch (axis) {
    case 'medium': return [it.medium];
    case 'genre': return it.genres;
    case 'tag': return it.tags;
    case 'status': return [it.status];
    case 'decade': return [it.first_release_year == null ? 'unknown' : String(Math.floor(it.first_release_year / 10) * 10)];
    case 'matrix': return [String(it.has_matrix)];
  }
}
const pass = (items: Item[], sel: Sel, exclude?: Axis) => items.filter((it) => AXES.every((a) => a === exclude || !sel[a]?.length || sel[a]!.some((v) => vals(it, a).includes(v))));
const ids = (items: Item[]) => items.map((i) => String(i.work_id)).sort();

async function resultIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('#search-results li.work-row > a')].map((a) => new URL(a.href).pathname.replace(/\/$/, '').split('/').pop()!));
}

async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__lat = [];
    w.__t0 = null;
    document.addEventListener('input', () => { w.__t0 = performance.now(); }, true);
    new MutationObserver(() => { if (w.__t0 !== null) { w.__lat.push(performance.now() - w.__t0); w.__t0 = null; } })
      .observe(document.querySelector('#search-results')!, { childList: true, subtree: true, characterData: true });
  });
}
const takeLatencies = (page: Page) => page.evaluate(() => { const w = window as any; const l = w.__lat as number[]; w.__lat = []; return l; });

test('T08 JS disabled: every work page reachable from /works/; A phase switch via radio + :has()', async ({ browser, rec }) => {
  const m = manifest();
  const external: string[] = [];
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await guardContext(ctx, external);
  const page = await ctx.newPage();
  const problems: string[] = [];
  try {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(url('/works/'));
      for (const w of m.works) {
        const target = url(w.url);
        const link = page.locator('main a[href]').filter({ hasText: w.title });
        const hrefs = await link.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
        const i = hrefs.indexOf(target);
        if (i < 0) { problems.push(`@${width} /works/: no plain link to ${w.url} (titled ${w.title})`); continue; }
        const resp = page.waitForResponse((r) => r.url() === target && r.request().resourceType() === 'document');
        await link.nth(i).click();
        const r = await resp;
        await page.waitForURL(target);
        const h1 = (await page.locator('h1').first().innerText()).trim();
        rec.add({ width, work: w.id, from: '/works/', status: r.status(), h1, expected: w.title });
        if (r.status() !== 200) problems.push(`@${width} ${w.url}: status ${r.status()}`);
        if (h1 !== w.title) problems.push(`@${width} ${w.url}: h1 "${h1}" != canonical title "${w.title}"`);
        await page.goBack();
        await page.waitForURL(url('/works/'));
      }
    }
    // A phase switching without JS (A10: the figure is shown directly at every width)
    for (const w of m.works.filter((x) => x.figures.A)) {
      for (const width of [768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(url(w.url + 'relations/'));
        const opts = page.locator('.fig-a .fig-switch__opt');
        const n = await opts.count();
        const seen = new Set<string>();
        const per: Record<string, unknown>[] = [];
        let varies = false;
        for (let i = 0; i < n; i++) {
          const pi = await opts.nth(i).locator('input').getAttribute('data-pi');
          await opts.nth(i).click(); await settle(page);
          const a = (await page.evaluate(readFigA))!;
          const s = a.svgs[0]!;
          varies = new Set(Object.values(s.staticSig)).size > 1;
          seen.add(s.edges.join(';'));
          per.push({ pi, checkedPi: a.checkedPi, visiblePi: s.visiblePi, visibleEdges: s.edges.length });
          if (JSON.stringify(s.visiblePi) !== JSON.stringify([pi])) problems.push(`no-JS ${w.url}relations/ @${width}: clicking phase ${pi} shows groups ${JSON.stringify(s.visiblePi)}`);
        }
        const search = await page.evaluate(() => location.search);
        rec.add({ width, work: w.id, noJsPhaseSwitch: per, relationsVaryInData: varies, distinctVisibleEdgeSets: seen.size, urlAfter: search });
        if (search) problems.push(`no-JS ${w.url}relations/: URL changed (${search}) - a script ran`);
        if (varies && seen.size < 2) problems.push(`no-JS ${w.url}relations/ @${width}: visible edges did not change across phases`);
      }
    }
  } finally {
    await ctx.close();
  }
  expect(external, 'runtime external requests (no-JS context)').toEqual([]);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('T09 search: title, reading and every alias put the work first; < 100 ms per input; 0-result links; ?q= round trip', async ({ page, rec }) => {
  const m = manifest();
  const problems: string[] = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, '/search/');
  await page.locator('#search-results li.work-row').first().waitFor();
  await instrument(page);
  const q = page.locator('#query');
  const allLat: number[] = [];
  for (const w of m.works) {
    const queries: { type: string; q: string }[] = [{ type: 'title', q: w.title }];
    if (w.reading) queries.push({ type: 'reading', q: w.reading });
    for (const a of w.aliases) {
      const info = w.aliasInfo.find((x) => x.text === a);
      queries.push({ type: info ? `alias(${info.kind}${info.attested ? '' : ', unattested'})` : 'alias', q: a });
    }
    for (const x of queries) {
      await q.fill('');
      await takeLatencies(page);
      await q.fill(x.q);
      const lat = await takeLatencies(page);
      const res = await resultIds(page);
      const first = res[0] ?? null;
      const note = await page.locator('#search-results li.work-row').first().innerText().catch(() => '');
      allLat.push(...lat);
      rec.add({ work: w.id, type: x.type, query: x.q, first, results: res.length, latencyMs: lat.map((v) => round(v)), firstRowText: note.replace(/\s+/g, ' ').slice(0, 80) });
      if (first !== w.id) problems.push(`"${x.q}" (${x.type}): first result ${first}, expected ${w.id}`);
      if (lat.length === 0) problems.push(`"${x.q}" (${x.type}): results never updated after input`);
      if (lat.some((v) => v >= 100)) problems.push(`"${x.q}" (${x.type}): latency ${lat.map((v) => round(v)).join(',')} ms >= 100`);
    }
    // keystroke-by-keystroke typing of the title
    await q.fill('');
    await takeLatencies(page);
    await q.pressSequentially(w.title);
    const keys = await takeLatencies(page);
    allLat.push(...keys);
    const firstTyped = (await resultIds(page))[0] ?? null;
    rec.add({ work: w.id, type: 'title typed per key', query: w.title, first: firstTyped, keystrokes: keys.length, maxLatencyMs: round(Math.max(0, ...keys)) });
    if (firstTyped !== w.id) problems.push(`typed "${w.title}": first result ${firstTyped}`);
    if (keys.some((v) => v >= 100)) problems.push(`typed "${w.title}": a keystroke took >= 100 ms (${round(Math.max(...keys))})`);
  }
  // 0 results
  const none = 'zzqxjvwkzzqxjvwk';
  await q.fill(none);
  const zero = await page.evaluate(() => {
    const r = document.querySelector('#search-results')!;
    return { rows: r.querySelectorAll('li.work-row').length, links: [...r.querySelectorAll<HTMLAnchorElement>('a')].map((a) => new URL(a.href).pathname) };
  });
  rec.add({ type: 'zero-result', query: none, ...zero });
  if (zero.rows !== 0) problems.push(`"${none}": expected 0 results, got ${zero.rows}`);
  if (!zero.links.some((p) => p.endsWith('/works/'))) problems.push('0 results: no link to the index (/works/)');
  if (!zero.links.some((p) => p.endsWith('/genres/'))) problems.push('0 results: no link to the genre list (/genres/)');
  // ?q= reflected and restored
  const w0 = m.works[0]!;
  await q.fill(w0.title);
  const u = new URL(page.url());
  const reflected = u.searchParams.get('q');
  await page.reload();
  await page.locator('#search-results li.work-row').first().waitFor();
  const restored = await q.inputValue();
  const firstAfter = (await resultIds(page))[0] ?? null;
  // direct visit + header search from another page (2 operations)
  await open(page, '/about/');
  await page.locator('#header-q').fill(w0.title);
  await page.locator('#header-q').press('Enter');
  await page.waitForURL(/\/search\/\?q=/);
  await page.locator('#search-results li.work-row').first().waitFor();
  const fromHeader = (await resultIds(page))[0] ?? null;
  rec.add({ type: 'url', query: w0.title, urlQ: reflected, afterReload: { input: restored, first: firstAfter }, headerSearchFromAbout: { url: new URL(page.url()).search, first: fromHeader }, maxLatencyMs: round(Math.max(0, ...allLat)), inputs: allLat.length });
  if (reflected !== w0.title) problems.push(`?q= not reflected (got ${reflected})`);
  if (restored !== w0.title) problems.push(`?q= not restored on reload (input "${restored}")`);
  if (firstAfter !== w0.id) problems.push(`after reload first result ${firstAfter}`);
  if (fromHeader !== w0.id) problems.push(`header search from /about/: first result ${fromHeader}`);
  expect(problems, problems.join('\n')).toEqual([]);
});

async function facetState(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('#search-filters input[type=checkbox]')].map((i) => ({
    axis: i.name, value: i.value, checked: i.checked, disabled: i.disabled,
    count: Number(document.querySelector(`[data-count="${i.name}:${i.value}"]`)?.textContent ?? NaN),
  })));
}

test('T10 filters: same-axis OR, cross-axis AND, counts, zero-count disabled, URL reflected and restored', async ({ page, rec }) => {
  const items = manifest().catalog as Item[];
  const problems: string[] = [];
  // choose an axis with >= 2 values for OR, and a pair across axes for AND
  const valuesOf = (a: Axis) => [...new Set(items.flatMap((i) => vals(i, a)))].sort();
  const orAxis = (['medium', 'genre', 'status', 'decade', 'matrix', 'tag'] as Axis[]).find((a) => valuesOf(a).length >= 2);
  // AND pair: prefer medium + genre; prefer a pair whose intersection is strictly narrower than one side.
  const cands: { a: Axis; x: string; b: Axis; y: string; narrows: boolean }[] = [];
  for (const a of ['medium', 'status', 'matrix', 'decade'] as Axis[]) for (const b of ['genre', 'tag', 'matrix', 'status'] as Axis[]) {
    if (a === b) continue;
    for (const x of valuesOf(a)) for (const y of valuesOf(b)) {
      const both = pass(items, { [a]: [x], [b]: [y] }).length;
      const nx = pass(items, { [a]: [x] }).length, ny = pass(items, { [b]: [y] }).length;
      if (both > 0) cands.push({ a, x, b, y, narrows: both < nx || both < ny });
    }
  }
  const and = cands.find((c) => c.narrows) ?? cands[0] ?? null;
  test.skip(!orAxis && !and, 'catalog too small for filter combinations');

  const checkCounts = async (sel: Sel, label: string) => {
    const st = await facetState(page);
    const bad: string[] = [];
    for (const o of st) {
      const expected = pass(items, sel, o.axis as Axis).filter((i) => vals(i, o.axis as Axis).includes(o.value)).length;
      if (o.count !== expected) bad.push(`${o.axis}:${o.value} count ${o.count} != ${expected}`);
      if (o.disabled !== (expected === 0)) bad.push(`${o.axis}:${o.value} disabled=${o.disabled} with count ${expected}`);
    }
    if (bad.length) problems.push(`${label}: ${bad.join('; ')}`);
    return st;
  };
  const urlSel = () => { const u = new URL(page.url()); const s: Record<string, string[]> = {}; for (const a of AXES) if (u.searchParams.getAll(a).length) s[a] = u.searchParams.getAll(a).sort(); return s; };

  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, '/search/');
  await page.locator('#search-results li.work-row').first().waitFor();
  await checkCounts({}, 'initial');

  if (orAxis) {
    const [v1, v2] = valuesOf(orAxis);
    await page.locator(`#search-filters input[name="${orAxis}"][value="${v1}"]`).check();
    await page.locator(`#search-filters input[name="${orAxis}"][value="${v2}"]`).check();
    const sel: Sel = { [orAxis]: [v1!, v2!] };
    const expected = ids(pass(items, sel));
    const got = (await resultIds(page)).sort();
    const st = await checkCounts(sel, `OR ${orAxis}=${v1}|${v2}`);
    rec.add({ step: 'same-axis OR', axis: orAxis, values: [v1, v2], expected, got, singleCounts: [ids(pass(items, { [orAxis]: [v1!] })).length, ids(pass(items, { [orAxis]: [v2!] })).length], url: new URL(page.url()).search, facets: st });
    if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`OR ${orAxis}=${v1}|${v2}: results ${got} != ${expected}`);
    if (JSON.stringify(urlSel()[orAxis]) !== JSON.stringify([v1, v2].sort())) problems.push(`OR: URL does not reflect ${orAxis} (${new URL(page.url()).search})`);
    await page.locator('#clear-filters').click();
  }

  if (and) {
    await page.locator(`#search-filters input[name="${and.a}"][value="${and.x}"]`).check();
    await page.locator(`#search-filters input[name="${and.b}"][value="${and.y}"]`).check();
    const sel: Sel = { [and.a]: [and.x], [and.b]: [and.y] };
    const expected = ids(pass(items, sel));
    const got = (await resultIds(page)).sort();
    const st = await checkCounts(sel, `AND ${and.a}=${and.x} & ${and.b}=${and.y}`);
    const zeroDisabled = st.filter((o) => o.count === 0);
    rec.add({ step: 'cross-axis AND', sel, expected, got, url: new URL(page.url()).search, zeroCountOptions: zeroDisabled.map((o) => `${o.axis}:${o.value} disabled=${o.disabled}`), facets: st });
    if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`AND: results ${got} != ${expected}`);
    const us = urlSel();
    if (!us[and.a]?.includes(and.x) || !us[and.b]?.includes(and.y)) problems.push(`AND: URL does not reflect the selection (${new URL(page.url()).search})`);
    if (zeroDisabled.length === 0) test.info().annotations.push({ type: 'note', description: 'no zero-count option arose in the AND state; disabled-state check covered by count==0 <=> disabled rule only' });
    // restore on reload, then after resize 360 -> 1280
    const before = new URL(page.url()).search;
    for (const step of ['reload', 'resize 360->1280']) {
      if (step === 'reload') { await page.reload(); await page.locator('#search-results').waitFor(); await page.waitForFunction(() => document.querySelector('#search-results')!.children.length > 0); }
      else await page.setViewportSize({ width: 1280, height: 800 });
      const st2 = await facetState(page);
      const checked = st2.filter((o) => o.checked).map((o) => `${o.axis}:${o.value}`).sort();
      const got2 = (await resultIds(page)).sort();
      const after = new URL(page.url()).search;
      rec.add({ step, checked, got: got2, url: after });
      if (JSON.stringify(checked) !== JSON.stringify([`${and.a}:${and.x}`, `${and.b}:${and.y}`].sort())) problems.push(`${step}: checked filters ${checked}`);
      if (JSON.stringify(got2) !== JSON.stringify(expected)) problems.push(`${step}: results ${got2} != ${expected}`);
      if (after !== before) problems.push(`${step}: URL ${after} != ${before}`);
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('T11 state retention (search): query and filters survive 360 <-> 1280', async ({ page, rec }) => {
  const m = manifest();
  const w = m.works[0]!;
  const problems: string[] = [];
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, '/search/');
  await page.locator('#search-results li.work-row').first().waitFor();
  await page.locator('#query').fill(w.title);
  const med = String((m.catalog.find((c) => c.work_id === w.id) as Item).medium);
  await page.locator(`#search-filters input[name="medium"][value="${med}"]`).check();
  const before = { url: new URL(page.url()).search, results: await resultIds(page) };
  for (const width of [1280, 360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const s = { width, input: await page.locator('#query').inputValue(), header: await page.locator('#header-q').inputValue(), medium: await page.locator(`#search-filters input[name="medium"][value="${med}"]`).isChecked(), url: new URL(page.url()).search, results: await resultIds(page) };
    rec.add(s);
    if (s.input !== w.title) problems.push(`@${width}: query lost ("${s.input}")`);
    if (!s.medium) problems.push(`@${width}: medium filter lost`);
    if (s.url !== before.url) problems.push(`@${width}: URL ${s.url} != ${before.url}`);
    if (JSON.stringify(s.results) !== JSON.stringify(before.results)) problems.push(`@${width}: results changed`);
  }
  expect(problems, problems.join('\n')).toEqual([]);
});
