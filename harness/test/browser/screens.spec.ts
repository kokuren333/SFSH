/** T13 full-page screenshots at 360 / 768 / 1280 for A, B, C (per work that has the figure), index, search results and the WP-5.4 common pages. */
import { mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test, expect, manifest, open } from './lib.ts';

const SHOT_WIDTHS = [360, 768, 1280];

test('T13 screenshots: A, B, C, index, search results, common pages at 360/768/1280', async ({ page, rec }) => {
  const m = manifest();
  const shots: { file: string; path: string; width: number }[] = [];
  for (const w of m.works) {
    if (w.figures.A) for (const x of SHOT_WIDTHS) shots.push({ file: `${w.id}/relations_${x}.png`, path: w.url + 'relations/', width: x });
    if (w.figures.B) for (const x of SHOT_WIDTHS) shots.push({ file: `${w.id}/reverse-plot_${x}.png`, path: w.url + 'reverse-plot/', width: x });
    if (w.figures.C) for (const x of SHOT_WIDTHS) shots.push({ file: `${w.id}/matrix_${x}.png`, path: w.url + 'matrix/', width: x });
  }
  const q = m.works[0]?.title ?? '';
  for (const x of SHOT_WIDTHS) {
    shots.push({ file: `site/index_${x}.png`, path: '/works/', width: x });
    shots.push({ file: `site/search_${x}.png`, path: '/search/?q=' + encodeURIComponent(q), width: x });
    for (const c of ['about', 'policy', 'takedown', 'spoilers']) shots.push({ file: `site/${c}_${x}.png`, path: `/${c}/`, width: x });
  }
  for (const s of shots) {
    await page.setViewportSize({ width: s.width, height: 800 });
    await open(page, s.path);
    if (s.path.startsWith('/search/')) await page.locator('#search-results li.work-row').first().waitFor();
    const file = join(m.screensDir, s.file);
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    const size = statSync(file).size;
    rec.add({ file: s.file, page: s.path, width: s.width, bytes: size });
    expect(size, s.file).toBeGreaterThan(1000);
  }
});
