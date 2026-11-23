import { resolve } from 'node:path';
import { build } from '../site/build.ts';
import { startPreviewServer } from '../site/preview.ts';
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Invalid site command option');
    result[args[i]!.slice(2)] = args[i + 1]!;
  }
  return result;
}
export async function buildCommand(args: string[]): Promise<number> {
  let opts: Record<string, string>;
  try { opts = options(args, ['--works-dir', '--out', '--base-url']); } catch (e) { console.error((e as Error).message); return 2; }
  try { await build({ worksDir: opts['works-dir'], out: opts.out, baseUrl: opts['base-url'] }); return 0; } catch (e) { console.error((e as Error).message); return 3; }
}
export async function previewCommand(args: string[]): Promise<number> {
  let opts: Record<string, string>;
  try { opts = options(args, ['--port', '--dir']); } catch (e) { console.error((e as Error).message); return 2; }
  const port = Number(opts.port ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('Invalid port'); return 2; }
  const server = await startPreviewServer({ dir: resolve(opts.dir || 'site/dist'), port });
  console.log(`Preview ${server.url}`);
  const stop = () => { void server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return 0;
}
