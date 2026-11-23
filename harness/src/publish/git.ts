/**
 * Minimal git runner for the publish side (WP-5.1 / 5.2). Every call:
 *  - drops inherited GIT_* environment variables (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE could redirect a command
 *    at the harness repository) and sets GIT_TERMINAL_PROMPT=0 (never wait for credentials);
 *  - runs with `-c core.autocrlf=false -c core.safecrlf=false` (blobs = dist bytes, so manifest hashes match);
 *  - prepends the caller's guard options (the protocol guard while the production gate is closed).
 * This module is the ONLY place in the harness that may run `git push` (see publishPushGuard test).
 */
import { spawnSync } from "node:child_process";

export interface GitOptions {
  cwd?: string;
  /** Extra leading `-c` options (e.g. PROTOCOL_GUARD). */
  guard?: string[];
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Return stdout as a Buffer (binary). */
  binary?: boolean;
  /** Do not throw on non-zero exit. */
  allowFail?: boolean;
  timeoutMs?: number;
}

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim().slice(0, 400)}`);
    this.name = "GitError";
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stdoutBuf: Buffer;
  stderr: string;
}

export function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return { ...env, ...extra };
}

export function git(args: string[], opts: GitOptions = {}): GitResult {
  const full = [...(opts.guard ?? []), "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args];
  const r = spawnSync("git", full, {
    cwd: opts.cwd,
    env: cleanGitEnv(opts.env),
    input: opts.input,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
    timeout: opts.timeoutMs ?? 5 * 60_000,
  });
  if (r.error) throw r.error;
  const stdoutBuf = r.stdout ?? Buffer.alloc(0);
  const res: GitResult = { code: r.status ?? -1, stdout: opts.binary ? "" : stdoutBuf.toString("utf8"), stdoutBuf, stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8") };
  if (res.code !== 0 && !opts.allowFail) throw new GitError(args, r.status, res.stderr);
  return res;
}

export const gitOut = (args: string[], opts: GitOptions = {}): string => git(args, opts).stdout.trim();

/** Read many blobs at once: oid → content. */
export function readBlobs(gitDir: string, oids: string[], guard: string[] = []): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!oids.length) return out;
  const r = git(["--git-dir", gitDir, "cat-file", "--batch"], { guard, input: oids.join("\n") + "\n", binary: true });
  const b = r.stdoutBuf;
  let i = 0;
  while (i < b.length) {
    const nl = b.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = b.toString("utf8", i, nl);
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(header);
    if (!m) throw new Error(`cat-file --batch: unexpected header "${header}"`);
    const size = Number(m[3]);
    out.set(m[1]!, b.subarray(nl + 1, nl + 1 + size));
    i = nl + 1 + size + 1;
  }
  return out;
}

/** `git ls-tree -r -z <ref>` → path → blob oid (files only). */
export function lsTree(gitDir: string, ref: string, guard: string[] = []): Map<string, string> {
  const r = git(["--git-dir", gitDir, "ls-tree", "-r", "-z", "--full-tree", ref], { guard });
  const m = new Map<string, string>();
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const t = rec.indexOf("\t");
    const [, type, oid] = rec.slice(0, t).split(" ");
    if (type === "blob") m.set(rec.slice(t + 1), oid!);
  }
  return m;
}
