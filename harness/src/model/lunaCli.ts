import fs from "node:fs";
import path from "node:path";
import { dropUndef } from "./haikuCli.ts";
import { makeTempDir, resolveCodex, rmTemp, runProcess, type Command } from "./proc.ts";
import { withModelSlot } from "./slots.ts";
import { ModelCallError, type RawCallResult, type RawInvoker, type TokenUsage, type ToolEvents, type ToolMode, type WebSearchEvent } from "./types.ts";
import { strictSchemaViolations } from "./validate.ts";

/**
 * Luna transport via Codex headless CLI (U-02 default = CLI):
 *   codex exec -m <id> --skip-git-repo-check --ephemeral -s read-only --ignore-user-config
 *     --color never <tool flags> --output-schema <schemaFile> -o <lastMsgFile> --json -
 * prompt on stdin, cwd = fresh empty temp dir (schema / last-message files live in a separate temp dir).
 *
 * Tool flags (measured CP-015): `-c web_search=disabled` alone lets codex fall back to the built-in
 * `codex_apps` MCP search, so the apps / browser / computer-use features are always disabled too.
 *   tools "none"       → -c web_search=disabled + fallbacks disabled (no tool calls at all)
 *   tools "web_search" → -c web_search=live     + fallbacks disabled (only structured web_search items)
 */
export function codexToolArgs(tools: ToolMode): string[] {
  return [
    "-c",
    tools === "web_search" ? "web_search=live" : "web_search=disabled",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
  ];
}

export function lunaCliInvoker(modelId: string, cmd: Command = resolveCodex()): RawInvoker {
  return async (req) => {
    const violations = strictSchemaViolations(req.schema);
    if (violations.length > 0) {
      throw new ModelCallError("bad_request", "luna", modelId, `schema not OpenAI-strict: ${violations.slice(0, 3).join("; ")}`);
    }
    const cwd = makeTempDir("sfsh_luna_");
    const io = makeTempDir("sfsh_luna_io_");
    const schemaFile = path.join(io, "schema.json");
    const lastFile = path.join(io, "last.txt");
    try {
      fs.writeFileSync(schemaFile, JSON.stringify(req.schema), "utf8");
      const args = [
        "exec",
        "-m",
        modelId,
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "read-only",
        "--ignore-user-config",
        "--color",
        "never",
        ...codexToolArgs(req.tools ?? "none"),
        "--output-schema",
        schemaFile,
        "-o",
        lastFile,
        "--json",
        "-",
      ];
      let r;
      try {
        r = await withModelSlot(() => runProcess(cmd, args, { stdin: req.prompt, cwd, timeoutMs: req.timeoutMs })); // A14: global cap
      } catch (e) {
        throw new ModelCallError("spawn", "luna", modelId, String(e));
      }
      if (r.timedOut) throw new ModelCallError("timeout", "luna", modelId, `no result within ${req.timeoutMs}ms`);
      const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8") : null;
      return parseCodexRun(modelId, r.code, r.stdout, r.stderr, last);
    } finally {
      rmTemp(cwd);
      rmTemp(io);
    }
  };
}

/** Exported for tests. stdout = JSONL events (--json); last = contents of the -o file (or null). */
export function parseCodexRun(
  modelId: string,
  code: number | null,
  stdout: string,
  stderr: string,
  last: string | null,
): RawCallResult {
  let usage: Record<string, unknown> | undefined;
  const errors: string[] = [];
  const webSearch: WebSearchEvent[] = [];
  let otherToolItems = 0;
  const otherToolTypes = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === "turn.completed" && ev.usage) usage = ev.usage;
    if (ev.type === "item.completed" && ev.item && typeof ev.item === "object") {
      const it = ev.item as Record<string, any>;
      if (it.type === "web_search") webSearch.push(toWebSearchEvent(it));
      else if (it.type && !NON_TOOL_ITEMS.has(String(it.type))) {
        otherToolItems++;
        otherToolTypes.add(String(it.type));
      }
    }
    if (ev.type === "error" && ev.message) errors.push(String(ev.message));
    if (ev.type === "turn.failed") errors.push(String(ev.error?.message ?? JSON.stringify(ev.error ?? ev)));
  }
  const errText = [...errors, stderr].join(" ");
  if (/model_not_found|model is not supported|does not exist/i.test(errText)) {
    throw new ModelCallError("model_not_found", "luna", modelId, firstMatchLine(errText) ?? "model_not_found");
  }
  if (code !== 0 || last === null || last.trim() === "") {
    const msg = errors[0] ?? lastLines(stderr) ?? `exit ${code}`;
    throw new ModelCallError("exit", "luna", modelId, `exit ${code}: ${msg}`.slice(0, 300));
  }
  let output: unknown;
  try {
    output = JSON.parse(last);
  } catch {
    throw new ModelCallError("parse", "luna", modelId, `last message is not JSON (${last.length} chars)`);
  }
  const tokens: TokenUsage = usage
    ? {
        input: n(usage.input_tokens),
        output: n(usage.output_tokens),
        cacheRead: n(usage.cached_input_tokens),
        cacheWrite: n(usage.cache_write_input_tokens),
        reasoning: n(usage.reasoning_output_tokens),
      }
    : {};
  const toolEvents: ToolEvents = { webSearch, otherToolItems, otherToolTypes: [...otherToolTypes].sort() };
  // codex --json does not report the served model id: reportedModelId = null, effective id = requested id
  // (unknown ids fail with model_not_found, so the request is never silently served by another model).
  return { output, raw: last, modelId, reportedModelId: null, toolEvents, tokens: dropUndef(tokens), costUsd: null };
}

/** Item types that are not tool calls. */
const NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "todo_list", "error"]);

function toWebSearchEvent(it: Record<string, any>): WebSearchEvent {
  const a = (it.action ?? {}) as Record<string, any>;
  const action = a.type === "search" ? "search" : a.type === "open_page" ? "open_page" : "other";
  const results = Array.isArray(it.results) ? it.results : [];
  return {
    itemId: String(it.id ?? ""),
    action,
    query: typeof a.query === "string" ? a.query : typeof it.query === "string" && it.query ? it.query : null,
    url: typeof a.url === "string" ? a.url : null,
    results: results
      .filter((r: any) => r && typeof r.url === "string")
      .map((r: any) => ({
        url: String(r.url),
        title: String(r.title ?? ""),
        domain: String(r.domain ?? ""),
        snippet: String(r.snippet ?? ""),
      })),
  };
}

function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function firstMatchLine(s: string): string | null {
  const msg = s.match(/"message":"((?:[^"\\]|\\.)*(?:not supported|does not exist|model_not_found)(?:[^"\\]|\\.)*)"/i);
  if (msg) return msg[1].slice(0, 300);
  const m = s.match(/[^\n]*(model_not_found|not supported|does not exist)[^\n]*/i);
  return m ? m[0].trim().slice(0, 300) : null;
}

function lastLines(s: string): string | null {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-2).join(" | ") : null;
}
