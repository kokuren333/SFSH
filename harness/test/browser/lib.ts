/** Shared fixtures for the WP-2.9 browser suite: manifest, external-request guard, measurement recorder. */
import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PageEntry { path: string; kind: string; work: string | null }
export interface WorkInfo {
  id: string; url: string; title: string; reading: string | null; aliases: string[];
  aliasInfo: { text: string; kind: string; attested: boolean }[];
  figures: { A: boolean; B: boolean; C: boolean };
  outcomeLabel: string | null;
}
export interface Manifest {
  base: string; runDir: string; dist: string; worksDir: string; buildOutput: string;
  screensDir: string; reportPath: string;
  pages: PageEntry[]; works: WorkInfo[]; catalog: Array<Record<string, unknown>>;
}

let cached: Manifest | null = null;
export function manifest(): Manifest {
  if (!cached) cached = JSON.parse(readFileSync(process.env.SFSH_BROWSER_MANIFEST!, 'utf8')) as Manifest;
  return cached;
}

/** Page kinds (REQUIREMENTS 6.2/6.5 + CP-026 people/events + WP-5.4 common pages). */
export const KINDS = ['top', 'index', 'search', 'genres', 'genre', 'media', 'creator', 'work', 'relations', 'reverse-plot', 'matrix',
  'themes', 'context', 'interpretations', 'quiz', 'sources', 'people', 'events', 'about', 'policy', 'takedown', 'spoilers', 'sitemap', '404'] as const;

export const WIDTHS = [360, 390, 600, 768, 1024, 1280, 1920] as const;
export interface VP { name: string; width: number; height: number }
export const VIEWPORTS: VP[] = [
  ...WIDTHS.map((w) => ({ name: String(w), width: w, height: 800 })),
  { name: '360-landscape', width: 800, height: 360 },
  { name: '768-landscape', width: 1024, height: 768 },
];

/** Every page of the kind when the site has < 300 pages; otherwise the first page of the kind per work (and the first non-work one). */
export function pagesOfKind(kind: string): PageEntry[] {
  const m = manifest();
  const all = m.pages.filter((p) => p.kind === kind);
  if (m.pages.length < 300) return all;
  const seen = new Set<string>();
  return all.filter((p) => { const k = p.work ?? '-'; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Allowed horizontal scroll frames (REQUIREMENTS 6.4: C matrix and data tables, inside their frame only). */
export const SCROLL_FRAMES = ['.fig-c__scroll', '.fig-table-wrap', '.table-frame'];

export const url = (p: string) => manifest().base + p;

/** Blocks and records every request that does not go to the preview origin. */
export async function guardContext(context: BrowserContext, external: string[]): Promise<void> {
  const origin = manifest().base;
  await context.route('**/*', async (route) => {
    const u = route.request().url();
    if (u === origin || u.startsWith(origin + '/')) return route.continue();
    external.push(u);
    return route.abort('blockedbyclient');
  });
}

export interface Recorder { add(entry: Record<string, unknown>): void; entries: Record<string, unknown>[] }

export const test = base.extend<{ guard: string[]; rec: Recorder }>({
  guard: [async ({ context }, use) => {
    const external: string[] = [];
    await guardContext(context, external);
    await use(external);
    expect(external, 'runtime external requests must be 0').toEqual([]);
  }, { auto: true }],
  rec: async ({}, use, testInfo) => {
    const r: Recorder = { entries: [], add(e) { this.entries.push(e); } };
    await use(r);
    const file = join(manifest().runDir, 'records', `${testInfo.testId}.json`);
    writeFileSync(file, JSON.stringify({ title: testInfo.title, entries: r.entries }));
  },
});
export { expect };

export async function open(page: Page, path: string): Promise<number> {
  const res = await page.goto(url(path), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return res?.status() ?? 0;
}

/**
 * AMENDMENT 09: the card view is the primary figure presentation at every width; the SVG / table figure sits in
 * `details.fig-more` ("図で見る"), shown from the tablet width (600) only. Figure tests of the full figure open it first.
 */
export const FULL_FIGURE_MIN = 600;
export const FULL_WIDTHS = WIDTHS.filter((w) => w >= FULL_FIGURE_MIN);
export async function openFull(page: Page): Promise<void> {
  await page.evaluate(() => { for (const d of document.querySelectorAll<HTMLDetailsElement>('details.fig-more')) d.open = true; });
}

/** Open the narrow-width menu so that its nav links are measured too. */
export async function openMobileMenu(page: Page): Promise<void> {
  await page.evaluate(() => { for (const d of document.querySelectorAll<HTMLDetailsElement>('details.mobile-menu')) d.open = true; });
}

export function round(n: number, d = 2): number { const f = 10 ** d; return Math.round(n * f) / f; }

/** Wait until every running CSS transition/animation (state-switch motion, <= 200 ms) has finished. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))).then(() => undefined));
}
