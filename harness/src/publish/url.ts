/**
 * Public-URL checks (REQUIREMENTS §6.3-7 post-publish verification, §5.4 takedown 404 check) and a local
 * GitHub-Pages stand-in that serves the branch of a bare repository (for the gate-closed tests and measurements).
 *
 * - verifyUrl:  GET every manifest file under base_url and compare sha256 (dotfiles skipped: Pages may not serve them).
 *               Polls until everything matches or the timeout passes (Pages deploys take a while).
 * - check404:   GET base_url + works/<id>/ (and catalog.json) until the page is 404 and the catalog no longer names
 *               the work.
 * - servePagesFromBare: http://127.0.0.1:<port>/ → `git show <branch>:<path>` of the bare, directory → index.html,
 *               missing → 404 with 404.html (like Pages). Reads the branch on every request, so a push is visible at once.
 * While the production gate is closed, URL checks only accept loopback hosts (no external traffic before opening).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { git } from "./git.ts";
import { sha256, type ManifestFile } from "./repo.ts";

export interface UrlCheckOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Gate closed → only loopback hosts are allowed. */
  loopbackOnly?: boolean;
  fetchImpl?: typeof fetch;
}

export function assertAllowedUrl(base: string, loopbackOnly: boolean): URL {
  const u = new URL(base);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`URL check: unsupported scheme ${u.protocol}`);
  if (loopbackOnly && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    throw new Error(`URL check: the production gate is closed; only loopback URLs may be checked (got ${u.hostname})`);
  return u;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UrlVerifyReport {
  ok: boolean;
  base_url: string;
  checked: number;
  mismatched: string[];
  missing: string[];
  attempts: number;
  elapsed_ms: number;
}

export async function verifyUrl(baseUrl: string, files: ManifestFile[], manifestSelf: { sha256: string } | null, opts: UrlCheckOptions = {}): Promise<UrlVerifyReport> {
  const base = assertAllowedUrl(baseUrl, opts.loopbackOnly ?? true);
  const f = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  const all = [...files, ...(manifestSelf ? [{ path: "release-manifest.json", sha256: manifestSelf.sha256 }] : [])].filter((x) => !x.path.split("/").some((s) => s.startsWith(".")));
  let attempts = 0;
  let last: UrlVerifyReport = { ok: false, base_url: base.href, checked: all.length, mismatched: [], missing: [], attempts: 0, elapsed_ms: 0 };
  for (;;) {
    attempts++;
    const mismatched: string[] = [];
    const missing: string[] = [];
    for (const file of all) {
      const res = await f(new URL(file.path, base), { redirect: "manual", cache: "no-store" });
      if (res.status !== 200) {
        missing.push(`${file.path} (${res.status})`);
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      if (sha256(Buffer.from(await res.arrayBuffer())) !== file.sha256) mismatched.push(file.path);
    }
    last = { ok: !mismatched.length && !missing.length, base_url: base.href, checked: all.length, mismatched, missing, attempts, elapsed_ms: Date.now() - t0 };
    if (last.ok || Date.now() - t0 >= (opts.timeoutMs ?? 0)) return last;
    await sleep(opts.intervalMs ?? 15_000);
  }
}

export interface Url404Report {
  ok: boolean;
  url: string;
  status: number | null;
  catalog_mentions: string[];
  attempts: number;
  elapsed_ms: number;
}

/** The work page must be 404 and catalog.json must not contain any needle (NFKC, case-insensitive). */
export async function check404(baseUrl: string, workId: string, needles: string[], opts: UrlCheckOptions = {}): Promise<Url404Report> {
  const base = assertAllowedUrl(baseUrl, opts.loopbackOnly ?? true);
  const f = opts.fetchImpl ?? fetch;
  const url = new URL(`works/${workId}/`, base).href;
  const t0 = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const res = await f(url, { redirect: "manual", cache: "no-store" });
    await res.arrayBuffer().catch(() => undefined);
    let mentions: string[] = [];
    const cat = await f(new URL("catalog.json", base), { cache: "no-store" });
    if (cat.status === 200) {
      const text = (await cat.text()).normalize("NFKC").toLowerCase();
      mentions = needles.filter((n) => text.includes(n.normalize("NFKC").toLowerCase()));
    } else await cat.arrayBuffer().catch(() => undefined);
    const ok = res.status === 404 && mentions.length === 0;
    if (ok || Date.now() - t0 >= (opts.timeoutMs ?? 0)) return { ok, url, status: res.status, catalog_mentions: mentions, attempts, elapsed_ms: Date.now() - t0 };
    await sleep(opts.intervalMs ?? 15_000);
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  woff2: "font/woff2",
  ico: "image/x-icon",
};

export interface PagesServer {
  url: string;
  close(): Promise<void>;
}

/** Local GitHub-Pages stand-in over a bare repository's branch (127.0.0.1 only). */
export async function servePagesFromBare(barePath: string, branch: string, port = 0): Promise<PagesServer> {
  const show = (p: string): Buffer | null => {
    if (p.split("/").some((s) => s === ".." || s.startsWith(".git"))) return null;
    const r = git(["--git-dir", barePath, "cat-file", "blob", `refs/heads/${branch}:${p}`], { binary: true, allowFail: true });
    return r.code === 0 ? r.stdoutBuf : null;
  };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
    if (p === "" || p.endsWith("/")) p += "index.html";
    let body = show(p);
    if (!body && !/\.[a-z0-9]+$/i.test(p)) {
      // /works/x → Pages redirects to /works/x/ when x/index.html exists
      if (show(`${p}/index.html`)) {
        res.writeHead(301, { location: `/${p}/` }).end();
        return;
      }
    }
    if (body) {
      const ext = p.split(".").pop()!.toLowerCase();
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
      return;
    }
    body = show("404.html");
    res.writeHead(404, { "content-type": TYPES.html! }).end(body ?? "404");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
