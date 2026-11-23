import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname, parse } from 'node:path';
import { stageWorks, repoRoot, isWithin } from './stage.ts';
import { applyA2ToDist } from '../check/dist.ts';
import type { SiteSettings } from '../../../site/src/site-settings.ts';

export function rendererArgs(out: string, baseUrl?: string): string[] {
  return ['--permission', ...['site/src', 'site/.input', 'node_modules'].map(p => `--allow-fs-read=${resolve(repoRoot, p)}`), `--allow-fs-write=${resolve(out)}`, resolve(repoRoot, 'site/src/build.ts'), resolve(out), ...(baseUrl ? [baseUrl] : [])];
}
export function run(executable: string, args: string[], env = process.env): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: repoRoot, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => code === 0 ? accept(stdout) : reject(new Error(`Build process failed (${code}): ${stderr}${stdout}`)));
  });
}
export async function listFiles(root: string, rel = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not publishable');
    if (entry.isDirectory()) files.push(...await listFiles(root, path)); else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
async function resolvedDestination(path: string): Promise<string> {
  try { return await realpath(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return join(await resolvedDestination(dirname(path)), path.slice(dirname(path).length + 1));
  }
}
/**
 * a2ReportPath: where the A-2 (dist) report goes (default logs/build/a2_last.json, outside dist).
 * site: public name / takedown window (WP-5.4). Default: harness/config/site.json. Staged as site/.input/site.public.json.
 */
export interface BuildOptions { worksDir?: string; out?: string; baseUrl?: string; a2ReportPath?: string; site?: SiteSettings }
export interface BuildSummary { works: number; pages: number; files: number; bytes: number; sitemap: boolean; a2: { detected: number; removed: number } }
export async function build(options: BuildOptions = {}): Promise<BuildSummary> {
  const out = resolve(options.out || resolve(repoRoot, 'site/dist')), worksDir = resolve(options.worksDir || resolve(repoRoot, 'works'));
  // Reject source trees and ancestors before any recursive deletion, including symlink aliases.
  const actual = await resolvedDestination(out), actualRepo = await realpath(repoRoot), actualWorks = await realpath(worksDir);
  // A caller may choose a temporary destination; source trees and their ancestors are never outputs.
  const protectedPaths = ['site/src', 'site/.input', 'harness', 'works', 'node_modules', 'logs', 'design', '.git', '.agents', '.codex', '.aws'].map(p => resolve(actualRepo, p));
  if (actual === parse(actual).root || isWithin(actual, actualRepo) || isWithin(actual, actualWorks) || isWithin(actualWorks, actual) || protectedPaths.some(p => isWithin(actual, p) || isWithin(p, actual))) throw new Error('Unsafe output directory');
  if (options.baseUrl) {
    const u = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash || u.username || u.password) throw new Error('Invalid base URL');
  }
  // site/.input is a single fixed staging dir read by the permissioned renderer: serialize builds (CP-032).
  const release = await acquireBuildLock();
  try {
  const index = await stageWorks(worksDir, options.site);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  const result = await run(process.execPath, rendererArgs(out, options.baseUrl));
  // Local compiler only: equivalent to npx tsc, without npm/network fallback.
  await run(process.execPath, [resolve(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'site/tsconfig.client.json', '--outDir', join(out, 'assets')]);
  // §5.1 A-2 (b): media in the build output is removed before the manifest; what cannot be removed fails the build.
  const a2 = applyA2ToDist(out, resolve(options.a2ReportPath || resolve(repoRoot, 'logs/build/a2_last.json')));
  const files = await listFiles(out);
  const manifest = [];
  for (const path of files) manifest.push({ path, sha256: createHash('sha256').update(await readFile(join(out, path))).digest('hex') });
  await writeFile(join(out, 'release-manifest.json'), JSON.stringify({ files: manifest }, null, 2) + '\n', 'utf8');
  let bytes = 0; for (const path of [...files, 'release-manifest.json']) bytes += (await readFile(join(out, path))).length;
  const summary: BuildSummary = { works: index.works.length, pages: Number(/pages=(\d+)/.exec(result)?.[1]), files: files.length + 1, bytes, sitemap: !!options.baseUrl, a2: { detected: a2.detected.length, removed: a2.removed } };
  console.log(`Built ${summary.works} works; ${summary.pages} pages; ${summary.files} files; ${summary.bytes} bytes; sitemap.xml ${summary.sitemap ? 'written' : 'omitted (no --base-url)'}; A-2 detected ${summary.a2.detected} removed ${summary.a2.removed}`);
  return summary;
  } finally { await release(); }
}

const LOCK_DIR = resolve(repoRoot, 'site/.input.lock');
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
/** Directory lock around staging + rendering (mkdir is atomic). A lock whose owner pid is dead is taken over. */
export async function acquireBuildLock(timeoutMs = 10 * 60_000): Promise<() => Promise<void>> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const t0 = Date.now();
  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(join(LOCK_DIR, 'owner'), token, 'utf8');
      return async () => {
        try { if ((await readFile(join(LOCK_DIR, 'owner'), 'utf8')) === token) await rm(LOCK_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let owner = '';
      try { owner = await readFile(join(LOCK_DIR, 'owner'), 'utf8'); } catch { /* being created or removed */ }
      const pid = Number(owner.split(':')[0]);
      if (owner && pid && !pidAlive(pid)) { await rm(LOCK_DIR, { recursive: true, force: true }); continue; }
      if (Date.now() - t0 > timeoutMs) throw new Error(`build lock busy (${LOCK_DIR}, owner ${owner || '?'})`);
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
