import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { isWithin } from './stage.ts';
export async function startPreviewServer({ dir, port }: { dir: string; port: number }): Promise<{ url: string; close(): Promise<void> }> {
  const root = await realpath(resolve(dir));
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.ico': 'image/x-icon' };
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent((req.url || '/').split('?')[0]!);
      if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) { res.writeHead(400); res.end('Invalid path'); return; }
      let file = resolve(root, '.' + path);
      if (!path.startsWith('/') || !isWithin(root, file)) { res.writeHead(400); res.end('Invalid path'); return; }
      if (path.endsWith('/')) file = join(file, 'index.html');
      let status = 200;
      try {
        if (!isWithin(root, await realpath(file)) || !(await stat(file)).isFile()) throw new Error('Missing');
      } catch { file = join(root, '404.html'); status = 404; }
      if (!isWithin(root, await realpath(file))) throw new Error('Outside preview');
      const body = await readFile(file);
      res.writeHead(status, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Preview failed to bind');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((ok, fail) => { server.close(e => e ? fail(e) : ok()); server.closeAllConnections(); }) };
}
