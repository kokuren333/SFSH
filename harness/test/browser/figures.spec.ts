/**
 * T04 figure A: node positions unchanged across phases per width class; visible relations follow the phase
 * T05 figure B: tree rooted at the Outcome (>=600), indented list with depth-2 expansion (360)
 * T06 figure C: reader column, cells >= 44px, scroll inside the frame only
 * T07 every figure has its alternative right after it, at every width
 * T11 state retention (figures): phase (A/C) and expansion survive 360 <-> 1280
 */
import type { Page } from '@playwright/test';
import { test, expect, WIDTHS, manifest, open, round, settle } from './lib.ts';
import { readFigA } from './probes.ts';

const WCLASS: Record<number, string> = { 360: 'narrow', 768: 'medium', 1280: 'wide' };

async function phaseOptions(page: Page, blockSel: string) {
  const opts = page.locator(`${blockSel} .fig-switch__opt`);
  const n = await opts.count();
  const out: { i: number; pi: string; value: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const input = opts.nth(i).locator('input.fig-phase-radio');
    out.push({ i, pi: (await input.getAttribute('data-pi'))!, value: (await input.getAttribute('value'))!, label: (await opts.nth(i).innerText()).trim() });
  }
  return { opts, list: out };
}

/** Runs the phase loop on the currently visible A set; returns problems. */
async function checkPhases(page: Page, wpath: string, width: number, setName: string, rec: { add(e: Record<string, unknown>): void }) {
  const problems: string[] = [];
  const base = await page.evaluate(readFigA);
  if (!base || base.svgs.length !== 1) { problems.push(`${wpath} @${width} [${setName}]: expected exactly 1 visible A svg, got ${base?.svgs.length ?? 'no block'}`); return { problems, varies: false, changed: false }; }
  const s0 = base.svgs[0]!;
  if (s0.wclass !== WCLASS[width]) problems.push(`${wpath} @${width} [${setName}]: visible width class ${s0.wclass}, expected ${WCLASS[width]}`);
  if (s0.set !== setName) problems.push(`${wpath} @${width}: visible set ${s0.set}, expected ${setName}`);
  const { opts, list } = await phaseOptions(page, '.fig-a');
  const sigs = new Set(Object.values(s0.staticSig));
  const varies = sigs.size > 1;
  const visibleSets = new Set<string>();
  const perPhase: Record<string, unknown>[] = [];
  for (const o of list) {
    await opts.nth(o.i).click(); await settle(page);
    const r = (await page.evaluate(readFigA))!;
    const s = r.svgs[0]!;
    const moved = s0.nodes.filter((n0) => { const n = s.nodes.find((x) => x.id === n0.id); return !n || n.cx !== n0.cx || n.cy !== n0.cy || n.transform !== n0.transform || Math.abs(n.x - n0.x) > 0.01 || Math.abs(n.y - n0.y) > 0.01; });
    const sig = s.edges.join(';');
    visibleSets.add(sig);
    perPhase.push({ phase: o.value, label: o.label, checkedPi: r.checkedPi, visiblePi: s.visiblePi, nodes: s.nodes.length, visibleEdges: s.edges.length, moved: moved.map((m) => m.id) });
    if (r.checkedPi !== o.pi) problems.push(`${wpath} @${width} [${setName}] ${o.label}: radio not checked after clicking its label (checked pi ${r.checkedPi})`);
    if (s.nodes.length !== s0.nodes.length) problems.push(`${wpath} @${width} [${setName}] ${o.label}: visible node count ${s.nodes.length} != ${s0.nodes.length}`);
    if (moved.length) problems.push(`${wpath} @${width} [${setName}] ${o.label}: nodes moved: ${moved.map((m) => m.id).join(',')}`);
    if (JSON.stringify(s.visiblePi) !== JSON.stringify([o.pi])) problems.push(`${wpath} @${width} [${setName}] ${o.label}: visible phase groups ${JSON.stringify(s.visiblePi)}, expected [${o.pi}]`);
    if (s0.staticSig[o.pi] !== undefined && sig !== s0.staticSig[o.pi]) problems.push(`${wpath} @${width} [${setName}] ${o.label}: visible edges differ from the phase's own relation group`);
  }
  const changed = visibleSets.size > 1;
  if (varies && !changed) problems.push(`${wpath} @${width} [${setName}]: relations differ between phases in the data but the visible edges never changed`);
  rec.add({ work: wpath, width, set: setName, wclass: s0.wclass, renderedWidth: s0.renderedWidth, nodes: s0.nodes.length, phases: list.length, relationsVaryInData: varies, visibleEdgeSetsSeen: visibleSets.size, perPhase });
  return { problems, varies, changed };
}

for (const width of [360, 768, 1280]) {
  test(`T04 figure A node positions unchanged across phases @${width}`, async ({ page, rec }) => {
    const works = manifest().works.filter((w) => w.figures.A);
    test.skip(works.length === 0, 'no work with figure A');
    await page.setViewportSize({ width, height: 800 });
    const problems: string[] = [];
    let anyVaries = false;
    for (const w of works) {
      await open(page, w.url + 'relations/');
      const main = await checkPhases(page, w.url + 'relations/', width, 'main', rec);
      problems.push(...main.problems);
      anyVaries ||= main.varies;
      const allToggle = page.locator('.fig-a label:has(input.fig-a__all)');
      if ((await allToggle.count()) > 0 && (await allToggle.first().isVisible())) {
        await allToggle.first().click(); await settle(page);
        const all = await checkPhases(page, w.url + 'relations/', width, 'all', rec);
        problems.push(...all.problems);
        anyVaries ||= all.varies;
        await allToggle.first().click();
      } else {
        rec.add({ work: w.url + 'relations/', width, set: 'all', note: 'no visible 全員を表示 toggle at this width' });
      }
    }
    if (!anyVaries) test.info().annotations.push({ type: 'note', description: 'no work in this run has relations that differ between phases; edge-change assertion not exercised' });
    rec.add({ width, anyWorkWithPhaseVaryingRelations: anyVaries });
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

function readFigB() {
  const shown = (e: Element | null) => !!e && e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const fig = document.querySelector('.fig-b figure[data-tree]');
  if (!fig) return null;
  const svgs = [...fig.querySelectorAll('svg.fig-b__svg')].filter(shown);
  const svg = svgs[0] ?? null;
  const rootTexts = svg ? [...svg.querySelectorAll('.fig-b__node--outcome .fig-b__label')].map((t) => (t.textContent || '').trim()) : [];
  const list = fig.querySelector('.fig-b__list');
  const rootItem = list?.querySelector(':scope > li') ?? null;
  const rootName = rootItem?.querySelector('.fig-b__name')?.textContent?.trim() ?? null;
  const details = list ? [...list.querySelectorAll('details')].map((d) => ({ depth: Number((d.closest('li[data-depth]') as HTMLElement | null)?.dataset.depth ?? -1), open: (d as HTMLDetailsElement).open })) : [];
  const items = list ? [...list.querySelectorAll<HTMLElement>('li[data-depth]')].map((li) => ({ depth: Number(li.dataset.depth), visible: shown(li) })) : [];
  return { tree: fig.getAttribute('data-tree'), visibleSvgs: svgs.length, wclass: (svg as HTMLElement | null)?.dataset?.wclass ?? null, rootTexts, listVisible: shown(list), rootName, details, items };
}

const sameLabel = (shownText: string, label: string) => shownText === label || (shownText.endsWith('…') && label.startsWith(shownText.slice(0, -1)));

test('T05 figure B tree rooted at the Outcome; list at 360 with depth-2 expansion', async ({ page, rec }) => {
  const works = manifest().works.filter((w) => w.figures.B);
  test.skip(works.length === 0, 'no work with figure B');
  const problems: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const w of works) {
      const p = w.url + 'reverse-plot/';
      await open(page, p);
      const r = await page.evaluate(readFigB);
      if (!r) { problems.push(`${p} @${width}: no figure[data-tree]`); continue; }
      const label = w.outcomeLabel ?? r.rootName ?? '';
      const svgRoot = r.rootTexts.join('');
      rec.add({ work: w.id, width, expectedRoot: label, groundTruth: w.outcomeLabel ? 'public.json trees[0].label' : 'list root', svgVisible: r.visibleSvgs, svgWclass: r.wclass, svgRootText: svgRoot, listVisible: r.listVisible, listRoot: r.rootName, details: r.details, maxVisibleDepth: Math.max(-1, ...r.items.filter((i) => i.visible).map((i) => i.depth)) });
      if (width >= 600) {
        if (r.visibleSvgs !== 1) problems.push(`${p} @${width}: expected the SVG tree to be shown (visible svgs: ${r.visibleSvgs})`);
        else if (!sameLabel(svgRoot, label)) problems.push(`${p} @${width}: SVG root text "${svgRoot}" != outcome "${label}"`);
      } else {
        if (r.visibleSvgs !== 0) problems.push(`${p} @${width}: SVG tree visible at phone width`);
        if (!r.listVisible) problems.push(`${p} @${width}: indented list not visible`);
        if (r.rootName !== label) problems.push(`${p} @${width}: list root "${r.rootName}" != outcome "${label}"`);
        const wrong = r.details.filter((d) => d.open !== d.depth < 2);
        if (wrong.length) problems.push(`${p} @${width}: default expansion is not depth 2: ${JSON.stringify(wrong)}`);
        const hidden = r.items.filter((i) => i.depth <= 2 && !i.visible);
        if (hidden.length) problems.push(`${p} @${width}: ${hidden.length} list item(s) of depth <= 2 not visible by default`);
        const deep = r.items.filter((i) => i.depth > 2 && i.visible);
        if (deep.length) problems.push(`${p} @${width}: ${deep.length} list item(s) deeper than 2 visible by default`);
      }
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

function readFigC() {
  const shown = (e: Element | null) => !!e && e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const block = document.querySelector('.fig-c');
  if (!block) return null;
  const frame = block.querySelector<HTMLElement>('.fig-c__scroll');
  const heads = [...block.querySelectorAll('thead th')].filter(shown);
  const reader = heads.filter((th) => (th.textContent || '').trim() === '読者');
  const cells = [...block.querySelectorAll('td.fig-c__cell')].filter(shown).map((td) => td.getBoundingClientRect());
  const de = document.documentElement;
  return {
    readerHeaders: reader.length,
    readerIsMarked: reader.some((th) => th.classList.contains('fig-c__aud')),
    readerRect: reader[0] ? (() => { const r = reader[0].getBoundingClientRect(); return { w: r.width, h: r.height }; })() : null,
    headers: heads.map((th) => (th.textContent || '').trim()),
    cellCount: cells.length,
    cellMinW: cells.length ? Math.min(...cells.map((r) => r.width)) : null,
    cellMinH: cells.length ? Math.min(...cells.map((r) => r.height)) : null,
    frame: frame ? { scrollWidth: frame.scrollWidth, clientWidth: frame.clientWidth, overflowX: getComputedStyle(frame).overflowX } : null,
    cueVisible: shown(block.querySelector('.fig-c__cue')),
    doc: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth },
  };
}

test('T06 figure C reader column, cells >= 44px, scroll inside the frame only', async ({ page, rec }) => {
  const works = manifest().works.filter((w) => w.figures.C);
  test.skip(works.length === 0, 'no work with figure C');
  const problems: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const w of works) {
      const p = w.url + 'matrix/';
      await open(page, p);
      const r = await page.evaluate(readFigC);
      if (!r || !r.frame) { problems.push(`${p} @${width}: no C block / scroll frame`); continue; }
      const overflows = r.frame.scrollWidth > r.frame.clientWidth + 1;
      let scrolled: number | null = null;
      if (overflows) {
        scrolled = await page.evaluate(() => { const f = document.querySelector<HTMLElement>('.fig-c .fig-c__scroll')!; f.scrollLeft = 100000; const x = f.scrollLeft; f.scrollLeft = 0; return x; });
      }
      rec.add({ work: w.id, width, readerHeaderVisible: r.readerHeaders, readerHeaderMarked: r.readerIsMarked, readerHeaderRect: r.readerRect, visibleHeaders: r.headers.length, cells: r.cellCount, cellMinW: r.cellMinW && round(r.cellMinW), cellMinH: r.cellMinH && round(r.cellMinH), frame: r.frame, frameOverflows: overflows, frameScrollLeftMax: scrolled, cueVisible: r.cueVisible, page: r.doc });
      if (r.readerHeaders !== 1) problems.push(`${p} @${width}: reader column header 「読者」 visible count ${r.readerHeaders}`);
      if (!r.readerIsMarked) problems.push(`${p} @${width}: reader column is not visually marked (.fig-c__aud)`);
      if (r.cellCount === 0) problems.push(`${p} @${width}: no visible cells`);
      if (r.cellMinW !== null && (r.cellMinW < 44 - 0.01 || r.cellMinH! < 44 - 0.01)) problems.push(`${p} @${width}: cell below 44px (min ${round(r.cellMinW)}x${round(r.cellMinH!)})`);
      if (r.doc.scrollWidth > r.doc.clientWidth) problems.push(`${p} @${width}: page scrolls horizontally (${r.doc.scrollWidth}/${r.doc.clientWidth})`);
      if (overflows) {
        if (!['auto', 'scroll'].includes(r.frame.overflowX)) problems.push(`${p} @${width}: frame overflows but overflow-x is ${r.frame.overflowX}`);
        if (!scrolled) problems.push(`${p} @${width}: frame overflows but does not scroll`);
        if (!r.cueVisible) problems.push(`${p} @${width}: frame overflows but the continuation cue is hidden`);
      }
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

function readAlts() {
  const shown = (e: Element | null) => { if (!e || !e.checkVisibility({ visibilityProperty: true }) || e.getClientRects().length === 0) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  // One entry per <figure>: its alternative is the first following sibling .fig-alt; only further figures of the same
  // block (several trees sharing one alternative) may sit in between.
  return [...document.querySelectorAll<HTMLElement>('.fig-block')].flatMap((block) => [...block.querySelectorAll<HTMLElement>('figure')].map((f, i) => {
    let n = f.nextElementSibling;
    const between: string[] = [];
    while (n && !n.classList.contains('fig-alt')) { if (n.tagName !== 'FIGURE') between.push(n.tagName.toLowerCase() + '.' + (n.getAttribute('class') || '')); n = n.nextElementSibling; }
    const alt = n as HTMLElement | null;
    const content = alt ? [...alt.querySelectorAll('table, ul, ol')] : [];
    return {
      fig: (block.dataset.fig || block.className) + (f.dataset.tree ? ':' + f.dataset.tree : '') + '#' + i,
      figureVisible: shown(f),
      alt: !!alt,
      altFor: alt?.dataset.altFor ?? null,
      altVisible: shown(alt),
      altContent: content.map((c) => c.tagName.toLowerCase()),
      altContentVisible: content.some(shown),
      between,
      followsAll: !!alt,
    };
  }));
}

test('T07 every figure has its alternative table/list right after it at every width', async ({ page, rec }) => {
  const m = manifest();
  const targets: { path: string; fig: string }[] = [];
  for (const w of m.works) {
    if (w.figures.A) targets.push({ path: w.url + 'relations/', fig: 'A' });
    if (w.figures.B) targets.push({ path: w.url + 'reverse-plot/', fig: 'B' });
    if (w.figures.C) targets.push({ path: w.url + 'matrix/', fig: 'C' });
  }
  test.skip(targets.length === 0, 'no figure in this site');
  const problems: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const t of targets) {
      await open(page, t.path);
      const blocks = await page.evaluate(readAlts);
      rec.add({ page: t.path, figure: t.fig, width, blocks });
      if (blocks.length === 0) problems.push(`${t.path} @${width}: no .fig-block`);
      for (const b of blocks) {
        const id = `${t.path} @${width} [${b.fig}]`;
        if (!b.alt) { problems.push(`${id}: no alternative (.fig-alt)`); continue; }
        if (!b.followsAll) problems.push(`${id}: alternative is not after the figure`);
        if (b.between.length) problems.push(`${id}: elements between figure and alternative: ${b.between.join(', ')}`);
        if (!b.altVisible || !b.altContentVisible) problems.push(`${id}: alternative not visible (container ${b.altVisible}, table/list ${b.altContentVisible})`);
        if (b.altContent.length === 0) problems.push(`${id}: alternative has no table or list`);
      }
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('T11 state retention (figures): phase A/C and B expansion survive 360 <-> 1280', async ({ page, rec }) => {
  const m = manifest();
  const problems: string[] = [];
  let checked = 0;
  for (const w of m.works) {
    for (const [fig, sub, block] of [['A', 'relations/', '.fig-a'], ['C', 'matrix/', '.fig-c']] as const) {
      if (!w.figures[fig]) continue;
      await page.setViewportSize({ width: 360, height: 800 });
      await open(page, w.url + sub);
      const { opts, list } = await phaseOptions(page, block);
      if (list.length < 2) { rec.add({ work: w.id, figure: fig, note: 'single phase; nothing to retain' }); continue; }
      const target = list[list.length - 1]!;
      await opts.nth(target.i).click(); await settle(page);
      const states: Record<string, unknown>[] = [];
      for (const width of [1280, 360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const s = await page.evaluate((sel) => {
          const b = document.querySelector(sel)!;
          const c = b.querySelector<HTMLInputElement>('.fig-phase-radio:checked');
          const vis = [...b.querySelectorAll<HTMLElement>('.fig-ph')].filter((g) => g.checkVisibility() && g.getClientRects().length > 0 && getComputedStyle(g).display !== 'none').map((g) => g.dataset.pi);
          return { checkedPi: c?.dataset.pi ?? null, visiblePi: [...new Set(vis)], url: location.search };
        }, block);
        states.push({ width, ...s });
        if (s.checkedPi !== target.pi) problems.push(`${w.url}${sub} @${width}: selected phase lost (checked ${s.checkedPi}, expected ${target.pi})`);
        if (JSON.stringify(s.visiblePi) !== JSON.stringify([target.pi])) problems.push(`${w.url}${sub} @${width}: visible phase groups ${JSON.stringify(s.visiblePi)}, expected [${target.pi}]`);
        if (!new URLSearchParams(s.url).getAll('phase').includes(target.value)) problems.push(`${w.url}${sub} @${width}: ?phase=${target.value} not in URL (${s.url})`);
      }
      // reload restores from ?phase=
      await page.reload();
      const after = await page.evaluate((sel) => document.querySelector(sel)!.querySelector<HTMLInputElement>('.fig-phase-radio:checked')?.dataset.pi ?? null, block);
      if (after !== target.pi) problems.push(`${w.url}${sub}: phase not restored from URL after reload (checked ${after})`);
      rec.add({ work: w.id, figure: fig, selected: target, states, afterReloadPi: after });
      checked++;
    }
    if (w.figures.B) {
      await page.setViewportSize({ width: 360, height: 800 });
      await open(page, w.url + 'reverse-plot/');
      const summ = page.locator('.fig-b .fig-b__list details > summary').first();
      if ((await summ.count()) > 0) {
        const before = await summ.evaluate((s) => (s.parentElement as HTMLDetailsElement).open);
        await summ.click();
        const toggled = !before;
        const states: Record<string, unknown>[] = [];
        for (const width of [1280, 360]) {
          await page.setViewportSize({ width, height: 800 });
          const open = await page.locator('.fig-b .fig-b__list details').first().evaluate((d) => (d as HTMLDetailsElement).open);
          states.push({ width, open });
          if (open !== toggled) problems.push(`${w.url}reverse-plot/ @${width}: expansion state lost (open=${open}, expected ${toggled})`);
        }
        rec.add({ work: w.id, figure: 'B', toggledTo: toggled, states });
        checked++;
      }
    }
  }
  test.skip(checked === 0, 'no phased figure / expandable list in this site');
  expect(problems, problems.join('\n')).toEqual([]);
});
