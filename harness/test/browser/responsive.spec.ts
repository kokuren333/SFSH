/**
 * T01 no page-level horizontal scroll (7 widths + 2 landscape, every page kind)
 * T02 overlap / clipping at 360 and 1280
 * T03 effective values at 360 (body text, figure text, tap targets + gaps)
 * T12 chromatic colours per screen <= 6 at 1280
 */
import { test, expect, KINDS, VIEWPORTS, SCROLL_FRAMES, pagesOfKind, open, openMobileMenu, manifest, settle } from './lib.ts';
import { layoutProbe, effectiveProbe, colorProbe } from './probes.ts';

test('T00 page inventory: every page kind present, >=1 work with each of A, B, C', async ({ rec }) => {
  const m = manifest();
  const counts: Record<string, number> = {};
  for (const p of m.pages) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const figs = { A: m.works.filter((w) => w.figures.A).map((w) => w.id), B: m.works.filter((w) => w.figures.B).map((w) => w.id), C: m.works.filter((w) => w.figures.C).map((w) => w.id) };
  rec.add({ worksDir: m.worksDir, dist: m.dist, build: m.buildOutput, pages: m.pages.length, works: m.works.map((w) => w.id), kinds: counts, figures: figs });
  expect(counts.other ?? 0, 'unclassified pages: ' + m.pages.filter((p) => p.kind === 'other').map((p) => p.path).join(', ')).toBe(0);
  for (const k of ['top', 'index', 'search', 'work', 'relations', 'reverse-plot', 'about', 'policy', 'takedown', 'spoilers', 'sitemap', '404']) expect(counts[k] ?? 0, `kind ${k}`).toBeGreaterThan(0);
  expect(figs.A.length, 'works with figure A').toBeGreaterThan(0);
  expect(figs.B.length, 'works with figure B').toBeGreaterThan(0);
  expect(figs.C.length, 'works with figure C').toBeGreaterThan(0);
});

for (const kind of KINDS) {
  test(`T01 no page-level horizontal scroll: ${kind}`, async ({ page, rec }) => {
    const pages = pagesOfKind(kind);
    test.skip(pages.length === 0, `no ${kind} page in this site`);
    const fails: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const p of pages) {
        await open(page, p.path);
        const r = await page.evaluate(layoutProbe, SCROLL_FRAMES);
        const docOver = r.doc.scrollWidth - r.doc.clientWidth, bodyOver = r.body.scrollWidth - r.body.clientWidth;
        const badFrames = r.scrollers.filter((s) => !s.allowed);
        const badFrameStyle = r.frameStyles.filter((f) => f.overflowX !== 'auto' && f.overflowX !== 'scroll');
        const masked = ['hidden', 'clip'].includes(r.doc.overflowX) || ['hidden', 'clip'].includes(r.body.overflowX);
        rec.add({ kind, page: p.path, viewport: vp.name, docScrollWidth: r.doc.scrollWidth, docClientWidth: r.doc.clientWidth, bodyScrollWidth: r.body.scrollWidth, bodyClientWidth: r.body.clientWidth, pageScrollX: r.scrollX, htmlOverflowX: r.doc.overflowX, bodyOverflowX: r.body.overflowX, scrollFrames: r.scrollers });
        if (docOver > 0 || bodyOver > 0 || r.scrollX > 0) fails.push(`${p.path} @${vp.name}: page overflows (html ${r.doc.scrollWidth}/${r.doc.clientWidth}, body ${r.body.scrollWidth}/${r.body.clientWidth}, scrollX ${r.scrollX})`);
        if (badFrames.length) fails.push(`${p.path} @${vp.name}: horizontal scroller outside allowed frames: ${JSON.stringify(badFrames)}`);
        if (badFrameStyle.length) fails.push(`${p.path} @${vp.name}: scroll frame not overflow-x auto|scroll: ${JSON.stringify(badFrameStyle)}`);
        if (masked) fails.push(`${p.path} @${vp.name}: page overflow masked by overflow-x ${r.doc.overflowX}/${r.body.overflowX}`);
      }
    }
    expect(fails, fails.join('\n')).toEqual([]);
  });
}

for (const kind of KINDS) {
  test(`T02 overlap / clipping at 360 and 1280: ${kind}`, async ({ page, rec }) => {
    const pages = pagesOfKind(kind);
    test.skip(pages.length === 0, `no ${kind} page in this site`);
    const fails: string[] = [];
    for (const w of [360, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      for (const p of pages) {
        await open(page, p.path);
        if (w === 360) await openMobileMenu(page);
        const r = await page.evaluate(layoutProbe, SCROLL_FRAMES);
        rec.add({ kind, page: p.path, width: w, textBeyondViewport: r.textOut, headerOverlaps: r.overlaps });
        if (r.textOut.length) fails.push(`${p.path} @${w}: text beyond viewport: ${JSON.stringify(r.textOut.slice(0, 5))}`);
        if (r.overlaps.length) fails.push(`${p.path} @${w}: header controls overlap: ${JSON.stringify(r.overlaps)}`);
      }
    }
    expect(fails, fails.join('\n')).toEqual([]);
  });
}

for (const kind of KINDS) {
  test(`T03 effective values at 360: ${kind}`, async ({ page, rec }) => {
    const pages = pagesOfKind(kind);
    test.skip(pages.length === 0, `no ${kind} page in this site`);
    const fails: string[] = [];
    await page.setViewportSize({ width: 360, height: 800 });
    for (const p of pages) {
      await open(page, p.path);
      await openMobileMenu(page);
      const r = await page.evaluate(effectiveProbe);
      const minOf = (a: { size: number }[]) => (a.length ? Math.min(...a.map((x) => x.size)) : null);
      const smallBody = r.bodyText.filter((t) => t.size < 16);
      const smallFig = r.figText.filter((t) => t.size < 13 - 0.01);
      const smallTap = r.tap.filter((t) => t.w < 44 - 0.01 || t.h < 44 - 0.01);
      const tightGap = r.gaps.filter((g) => g.gap < 8 - 0.01);
      const minGap = r.gaps.length ? Math.min(...r.gaps.map((g) => g.gap)) : null;
      const minTap = r.tap.length ? { w: Math.min(...r.tap.map((t) => t.w)), h: Math.min(...r.tap.map((t) => t.h)) } : null;
      rec.add({
        kind, page: p.path, width: 360,
        bodyTextMinPx: minOf(r.bodyText), bodyTextCount: r.bodyText.length, bodyTextBelow16: smallBody,
        auxSmallTextOutsideFigures: r.auxText,
        figureTextMinRenderedPx: minOf(r.figText), figureTextCount: r.figText.length, figureTextBelow13: smallFig,
        figureSvgTextMinRenderedPx: minOf(r.figText.filter((t) => t.svg)),
        tapTargetCount: r.tap.length, tapTargetMin: minTap, tapTargetsBelow44: smallTap,
        tapGapMinPx: minGap, tapGapsBelow8: tightGap, tapExcluded: r.excluded, tapTargets: r.tap,
      });
      if (smallBody.length) fails.push(`${p.path}: body text < 16px: ${JSON.stringify(smallBody.slice(0, 6))}`);
      if (smallFig.length) fails.push(`${p.path}: figure text < 13px rendered: ${JSON.stringify(smallFig.slice(0, 6))}`);
      if (smallTap.length) fails.push(`${p.path}: tap targets < 44x44: ${JSON.stringify(smallTap.slice(0, 8).map((t) => ({ el: t.el, w: t.w, h: t.h, text: t.text })))}`);
      if (tightGap.length) fails.push(`${p.path}: tap target gap < 8px: ${JSON.stringify(tightGap.slice(0, 8))}`);
    }
    expect(fails, fails.join('\n')).toEqual([]);
  });
}

for (const kind of KINDS) {
  test(`T12 chromatic colours per screen <= 6 at 1280: ${kind}`, async ({ page, rec }) => {
    const pages = pagesOfKind(kind);
    test.skip(pages.length === 0, `no ${kind} page in this site`);
    const fails: string[] = [];
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const p of pages) {
      await open(page, p.path);
      // default state, then every phase of every phased figure (each is a distinct "screen")
      const states: string[] = ['default'];
      const opts = page.locator('.fig-switch__opt');
      const n = await opts.count();
      for (let i = 0; i <= n; i++) {
        if (i > 0) { const o = opts.nth(i - 1); if (!(await o.isVisible())) continue; await o.click(); await settle(page); states.push('phase option ' + i + ': ' + (await o.innerText()).trim()); }
        const colors = await page.evaluate(colorProbe);
        rec.add({ kind, page: p.path, width: 1280, state: states[states.length - 1], chromaticCount: colors.length, colors });
        if (colors.length > 6) fails.push(`${p.path} [${states[states.length - 1]}]: ${colors.length} chromatic colours: ${JSON.stringify(colors)}`);
      }
    }
    expect(fails, fails.join('\n')).toEqual([]);
  });
}
