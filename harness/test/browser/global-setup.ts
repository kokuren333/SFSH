/**
 * Builds the site once (or uses SFSH_BROWSER_DIST), starts the loopback preview server, classifies every HTML page
 * into a page kind and writes the run manifest. Data reaches the workers through env vars (SFSH_BROWSER_MANIFEST).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from '../../src/site/preview.ts';
import type { Manifest, PageEntry, WorkInfo } from './lib.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const SUB_KINDS = new Set(['relations', 'reverse-plot', 'matrix', 'themes', 'context', 'interpretations', 'quiz', 'sources', 'people', 'events']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

export function classify(rel: string): { path: string; kind: string; work: string | null } {
  const parts = rel.split('/');
  const url = rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? '/' + rel.slice(0, -'index.html'.length) : '/' + rel;
  if (rel === 'index.html') return { path: url, kind: 'top', work: null };
  if (rel === '404.html') return { path: url, kind: '404', work: null };
  if (parts.length === 2 && parts[1] === 'index.html') {
    const k = parts[0]!;
    const map: Record<string, string> = { works: 'index', search: 'search', genres: 'genres', about: 'about', policy: 'policy', takedown: 'takedown', spoilers: 'spoilers', sitemap: 'sitemap' };
    return { path: url, kind: map[k] ?? 'other', work: null };
  }
  if (parts.length === 3 && parts[2] === 'index.html') {
    if (parts[0] === 'genres') return { path: url, kind: 'genre', work: null };
    if (parts[0] === 'media') return { path: url, kind: 'media', work: null };
    if (parts[0] === 'creators') return { path: url, kind: 'creator', work: null };
    if (parts[0] === 'works') return { path: url, kind: 'work', work: parts[1]! };
  }
  if (parts.length === 4 && parts[0] === 'works' && parts[3] === 'index.html' && SUB_KINDS.has(parts[2]!)) {
    return { path: url, kind: parts[2]!, work: parts[1]! };
  }
  return { path: url, kind: 'other', work: null };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const runDir = mkdtempSync(join(tmpdir(), 'sfsh-browser-'));
  mkdirSync(join(runDir, 'records'), { recursive: true });
  const worksEnv = process.env.SFSH_BROWSER_WORKS || 'works';
  const worksDir = resolve(ROOT, worksEnv);
  let dist: string;
  let buildOutput = '';
  if (process.env.SFSH_BROWSER_DIST) {
    dist = resolve(ROOT, process.env.SFSH_BROWSER_DIST);
  } else {
    dist = join(runDir, 'dist');
    buildOutput = execFileSync(process.execPath, ['harness/src/cli.ts', 'build', '--works-dir', worksDir, '--out', dist], { cwd: ROOT, encoding: 'utf8' }).trim();
  }
  const server = await startPreviewServer({ dir: dist, port: 0 });

  const pages: PageEntry[] = walk(dist).map((f) => classify(relative(dist, f).split(sep).join('/'))).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const catalog = JSON.parse(readFileSync(join(dist, 'catalog.json'), 'utf8')) as Array<Record<string, unknown>>;
  const html = (p: string) => { const f = join(dist, p.replace(/^\//, ''), p.endsWith('/') ? 'index.html' : ''); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  let indexWorks: Array<{ work_id: string; aliases?: Array<{ text: string; kind: string; attested: boolean }> }> = [];
  try { indexWorks = JSON.parse(readFileSync(join(worksDir, "INDEX.json"), "utf8")).works ?? []; } catch { indexWorks = []; }
  const works: WorkInfo[] = catalog.map((c) => {
    const id = String(c.work_id);
    const url = '/' + String(c.url);
    let outcomeLabel: string | null = null;
    const pub = join(worksDir, id, 'gen', 'public.json');
    if (existsSync(pub)) {
      try { outcomeLabel = JSON.parse(readFileSync(pub, 'utf8'))?.viz?.reverse_plot?.trees?.[0]?.label ?? null; } catch { outcomeLabel = null; }
    }
    return {
      id,
      url,
      title: String(c.title),
      reading: (c.title_reading as string | null) ?? null,
      aliases: (c.aliases as string[]) ?? [],
      aliasInfo: (indexWorks.find((x) => x.work_id === id)?.aliases ?? []).map((a) => ({ text: a.text, kind: a.kind, attested: a.attested })),
      figures: {
        A: html(url + 'relations/').includes('data-fig="relations"'),
        B: html(url + 'reverse-plot/').includes('data-fig="reverse-plot"'),
        C: html(url + 'matrix/').includes('data-fig="matrix"'),
      },
      outcomeLabel,
    };
  });
  const manifest: Manifest = {
    base: server.url,
    runDir,
    dist: process.env.SFSH_BROWSER_DIST ? relative(ROOT, dist).split(sep).join('/') : '(temp build)',
    worksDir: relative(ROOT, worksDir).split(sep).join('/') || '.',
    buildOutput,
    screensDir: resolve(ROOT, process.env.SFSH_SCREENS_DIR || 'logs/m2/screens'),
    reportPath: resolve(ROOT, process.env.SFSH_BROWSER_REPORT || 'logs/m2/browser_report.json'),
    pages,
    works,
    catalog,
  };
  const mf = join(runDir, 'manifest.json');
  writeFileSync(mf, JSON.stringify(manifest, null, 2));
  process.env.SFSH_BROWSER_MANIFEST = mf;
  console.log(`[sfsh-browser] works=${manifest.worksDir} pages=${pages.length} works=${works.length} base=${server.url} ${buildOutput}`);
  return async () => {
    await server.close();
    // the temp build is removed here (after the server released it); records/manifest are removed by the reporter
    if (!process.env.SFSH_BROWSER_DIST) rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
