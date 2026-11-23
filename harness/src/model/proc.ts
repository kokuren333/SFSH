import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Command {
  /** Executable path (a real .exe / node binary — never a .cmd shim; we always spawn with shell:false). */
  file: string;
  /** Leading args (e.g. the codex.js script path when file is node). */
  prefixArgs: string[];
}

/** Run a process with shell:false, feed stdin, collect output, kill the tree on timeout. */
export function runProcess(
  cmd: Command,
  args: string[],
  opts: { stdin: string; cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, [...cmd.prefixArgs, ...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.on("error", () => {
      /* child may exit before reading stdin; surfaced via exit code */
    });
    child.stdin.end(opts.stdin, "utf8");
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Fresh empty temp directory; caller removes it with rmTemp. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Resolve the Claude Code CLI to a directly spawnable executable.
 * Override with SFSH_CLAUDE_BIN. On Windows the npm shim `claude.cmd` wraps
 * node_modules/@anthropic-ai/claude-code/bin/claude.exe — we spawn the .exe itself
 * (shell:false, so JSON args are passed without cmd.exe re-quoting).
 */
export function resolveClaude(): Command {
  const env = process.env.SFSH_CLAUDE_BIN;
  if (env) return { file: env, prefixArgs: [] };
  if (process.platform !== "win32") return { file: findOnPath(["claude"]) ?? "claude", prefixArgs: [] };
  const exe = findOnPath(["claude.exe"]);
  if (exe) return { file: exe, prefixArgs: [] };
  const shim = findOnPath(["claude.cmd"]);
  if (shim) {
    const target = path.join(path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fs.existsSync(target)) return { file: target, prefixArgs: [] };
  }
  throw new Error("claude CLI not found (set SFSH_CLAUDE_BIN to claude.exe)");
}

/**
 * Resolve the Codex CLI. Override with SFSH_CODEX_JS (path to codex.js). On Windows the npm shim
 * `codex.cmd` runs `node .../@openai/codex/bin/codex.js` — we run that script with our own node.
 */
export function resolveCodex(): Command {
  const env = process.env.SFSH_CODEX_JS;
  if (env) return { file: process.execPath, prefixArgs: [env] };
  if (process.platform !== "win32") return { file: findOnPath(["codex"]) ?? "codex", prefixArgs: [] };
  const shim = findOnPath(["codex.cmd"]);
  if (shim) {
    const js = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(js)) return { file: process.execPath, prefixArgs: [js] };
  }
  const exe = findOnPath(["codex.exe"]);
  if (exe) return { file: exe, prefixArgs: [] };
  throw new Error("codex CLI not found (set SFSH_CODEX_JS to codex.js)");
}
