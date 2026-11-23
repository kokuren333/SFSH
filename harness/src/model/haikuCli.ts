import { makeTempDir, resolveClaude, rmTemp, runProcess, type Command } from "./proc.ts";
import { withModelSlot } from "./slots.ts";
import { ModelCallError, type RawCallResult, type RawInvoker, type TokenUsage } from "./types.ts";

/**
 * Haiku transport via Claude Code headless CLI (U-02 default = CLI):
 *   claude -p --model <id> --output-format json --json-schema <schemaJSON> --tools "" --strict-mcp-config
 * prompt on stdin, cwd = fresh empty temp dir.
 */
export function haikuCliInvoker(modelId: string, cmd: Command = resolveClaude()): RawInvoker {
  return async (req) => {
    if (req.tools && req.tools !== "none") {
      throw new ModelCallError("bad_request", "haiku", modelId, `tools "${req.tools}" not supported on the haiku port`);
    }
    const cwd = makeTempDir("sfsh_haiku_");
    try {
      const args = [
        "-p",
        "--model",
        modelId,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(req.schema),
        "--tools",
        "",
        "--strict-mcp-config",
      ];
      let r;
      try {
        r = await withModelSlot(() => runProcess(cmd, args, { stdin: req.prompt, cwd, timeoutMs: req.timeoutMs })); // A14: global cap
      } catch (e) {
        throw new ModelCallError("spawn", "haiku", modelId, String(e));
      }
      if (r.timedOut) throw new ModelCallError("timeout", "haiku", modelId, `no result within ${req.timeoutMs}ms`);
      return parseClaudeEnvelope(modelId, r.code, r.stdout, r.stderr);
    } finally {
      rmTemp(cwd);
    }
  };
}

/** Exported for tests. */
export function parseClaudeEnvelope(modelId: string, code: number | null, stdout: string, stderr: string): RawCallResult {
  let env: Record<string, any>;
  try {
    env = JSON.parse(stdout.trim());
  } catch {
    const msg = (stderr || stdout).trim().slice(0, 300) || `exit ${code}`;
    const kind = /model.{0,40}(not.?found|not exist|invalid|not available)|not_found_error/i.test(msg)
      ? "model_not_found"
      : code === 0
        ? "parse"
        : "exit";
    throw new ModelCallError(kind, "haiku", modelId, msg);
  }
  if (env.is_error || code !== 0) {
    const msg = String(env.result ?? env.error ?? `exit ${code}`).slice(0, 300);
    const kind = /model.{0,40}(not.?found|not exist|invalid|not available)|not_found_error/i.test(msg) ? "model_not_found" : "exit";
    throw new ModelCallError(kind, "haiku", modelId, msg);
  }
  let output: unknown;
  let raw: string;
  if (env.structured_output !== undefined && env.structured_output !== null) {
    output = env.structured_output;
    raw = JSON.stringify(output);
  } else {
    raw = String(env.result ?? "");
    try {
      output = JSON.parse(raw);
    } catch {
      throw new ModelCallError("parse", "haiku", modelId, `result is not JSON (${raw.length} chars)`);
    }
  }
  const usage = env.usage ?? {};
  const tokens: TokenUsage = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
  const used = Object.keys(env.modelUsage ?? {});
  const reported = used.length === 0 ? null : used.includes(modelId) ? modelId : used.join("+");
  return {
    output,
    raw,
    modelId: reported ?? modelId,
    reportedModelId: reported,
    tokens: dropUndef(tokens),
    costUsd: num(env.total_cost_usd) ?? null,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function dropUndef<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
