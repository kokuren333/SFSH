import { copyFile, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogItem, PublicWork, SiteInputIndex, Medium } from '../../../site/src/public-types.ts';
import type { WorksIndex } from '../works/types.ts';
import { compareReading } from '../../../site/src/search-core.ts';
import { validateSiteSettings } from '../../../site/src/site-settings.ts';
import type { SiteSettings } from '../../../site/src/site-settings.ts';
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function isWithin(root: string, path: string): boolean {
  const r = relative(resolve(root), resolve(path)); return r === '' || (r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') && !isAbsolute(r));
}
export function safeSegment(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error('Invalid public path segment');
}
export const siteSettingsPath = resolve(repoRoot, 'harness/config/site.json');
/** Reads and strictly validates harness/config/site.json (WP-5.4). Invalid settings throw (the build fails). */
export async function loadSiteSettings(path = siteSettingsPath): Promise<SiteSettings> {
  return validateSiteSettings(JSON.parse(await readFile(path, 'utf8')));
}
/** Stages INDEX → site/.input/index.public.json and the site settings → site/.input/site.public.json. */
export async function stageWorks(worksDir = resolve(repoRoot, 'works'), site?: SiteSettings): Promise<SiteInputIndex> {
  worksDir = resolve(worksDir);
  const settings = site === undefined ? await loadSiteSettings() : validateSiteSettings(site);
  const staging = resolve(repoRoot, 'site/.input');
  const source = JSON.parse(await readFile(join(worksDir, 'INDEX.json'), 'utf8')) as WorksIndex;
  const vocab = async (name: 'genres' | 'tags'): Promise<{ slug: string; label: string }[]> => {
    try {
      const data = JSON.parse(await readFile(resolve(repoRoot, `harness/config/${name}.json`), 'utf8'));
      return (data[name] as { slug: string; label: string }[]).map(v => { safeSegment(v.slug); return { slug: v.slug, label: v.label }; }).sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
    } catch (e) { if (name === 'tags' && (e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  };
  const index: SiteInputIndex = { schema: 'sfsh-index/1', generated_from: 'works/INDEX.json', works: [], vocab: { genres: await vocab('genres'), tags: await vocab('tags'), media: Object.entries({ novel: '小説', manga: '漫画', anime: 'アニメ', film: '映画', drama: 'ドラマ', game: 'ゲーム', other: 'その他' }).map(([slug, label]) => ({ slug: slug as Medium, label })) } };
  // Fixed, verified absolute target; never derive this deletion from caller input.
  if (!isWithin(repoRoot, staging) || staging === resolve(repoRoot)) throw new Error('Unsafe staging path');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const seen = new Set<string>();
  for (const entry of source.works) {
    if (entry.publish_mode !== 'Public') continue;
    safeSegment(entry.work_id);
    if (seen.has(entry.work_id)) throw new Error('Duplicate work id');
    seen.add(entry.work_id);
    const file = join(worksDir, entry.work_id, 'gen/public.json');
    let publicWork: PublicWork;
    try {
      if (!isWithin(await realpath(worksDir), await realpath(file))) throw new Error('Public input escapes works directory');
      publicWork = JSON.parse(await readFile(file, 'utf8')) as PublicWork;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (publicWork.schema !== 'sfsh-public/1' || publicWork.work.work_id !== entry.work_id) throw new Error('Public header does not match index');
    const w = publicWork.work;
    for (const segment of [...w.genres, ...w.tags, w.medium]) safeSegment(segment);
    if (w.genres.some(g => !index.vocab.genres.some(v => v.slug === g)) || w.tags.some(t => !index.vocab.tags.some(v => v.slug === t))) throw new Error('Unknown public vocabulary');
    const item: CatalogItem = {
      work_id: w.work_id, url: `works/${w.work_id}/`, title: w.title, title_original: w.title_original, title_reading: w.title_reading,
      aliases: entry.aliases.map(a => a.text), medium: w.medium, creators: w.creators.map(c => c.name), genres: w.genres, tags: w.tags,
      status: w.status, first_release_year: w.first_release_year, coverage_label: w.coverage_label, spoiler_max: w.spoiler_max,
      has_matrix: w.has_matrix, first_published_at: w.first_published_at, updated_at: w.updated_at,
    };
    index.works.push(item);
    const dest = join(staging, 'works', w.work_id); await mkdir(dest, { recursive: true });
    await copyFile(file, join(dest, 'public.json'));
  }
  index.works.sort(compareReading);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(staging, 'index.public.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  await writeFile(join(staging, 'site.public.json'), JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return index;
}
