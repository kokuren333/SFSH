// The single read boundary: staged JSON and renderer-owned assets only.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublicWork, SiteInputIndex } from './public-types.ts';
import { validateSiteSettings } from './site-settings.ts';
import type { SiteSettings } from './site-settings.ts';
export const sourceRoot = fileURLToPath(new URL('./', import.meta.url));
export const inputRoot = resolve(sourceRoot, '../.input');
function inside(root: string, target: string): boolean {
  const rel = relative(root, target); return rel !== '..' && !rel.startsWith('..' + '/') && !rel.startsWith('..\\') && !isAbsolute(rel);
}
export function readInput(rel: string): string {
  const target = resolve(inputRoot, rel);
  if (!inside(inputRoot, target) || !inside(realpathSync(inputRoot), realpathSync(target))) throw new Error('Input path outside staged input');
  return readFileSync(target, 'utf8');
}
export function readSource(rel: string, optional = false): string {
  const target = resolve(sourceRoot, rel);
  if (!inside(sourceRoot, target)) throw new Error('Source path outside renderer');
  try { return readFileSync(target, 'utf8'); } catch (e) { if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}
export function loadInput(): { index: SiteInputIndex; works: PublicWork[]; site: SiteSettings } {
  // Deliberately bypass L1 only for the L2 regression test; the OS must deny this read.
  if (process.env.SFSH_TEST_FORBIDDEN === '1') readFileSync(resolve(inputRoot, '../fixtures/forbidden.json'), 'utf8');
  const index = JSON.parse(readInput('index.public.json')) as SiteInputIndex;
  // Site settings (WP-5.4) are re-validated here: the renderer never trusts the staged file blindly.
  const site = validateSiteSettings(JSON.parse(readInput('site.public.json')));
  return { index, works: index.works.map(w => JSON.parse(readInput(`works/${w.work_id}/public.json`)) as PublicWork), site };
}
