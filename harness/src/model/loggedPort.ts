import { buildCallLogLine, type CallLogger } from "./callLog.ts";
import {
  ModelCallError,
  SchemaValidationError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type PortName,
  type RawCallResult,
  type RawInvoker,
} from "./types.ts";
import { validateAgainst } from "./validate.ts";

export const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * CP-035 d / M4: a model CLI that exits non-zero without a usable answer (kind "exit") is retried once at the call
 * level after a short pause, before the stage-level retry (runner, 2 retries) re-runs the whole stage. Measured
 * before M4: haiku 2 "exit 1" in 144 calls, luna 0 in 147 (logs/m4/transient_before.json); one such failure cost
 * ~8 minutes of stage re-run in the M3 repro. Each attempt writes its own call-log line, so the frequency stays measurable.
 * Deterministic failures (schema_invalid, model_not_found, bad_request, parse, timeout, spawn) are not retried here.
 */
export interface RetryPolicy {
  transientRetries: number;
  delayMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { transientRetries: 1, delayMs: 5_000 };

/**
 * Wraps a backend transport with: JSON Schema validation (ajv) and one call-log line per call
 * (success or failure). Invalid output → logged, then SchemaValidationError is thrown.
 */
export class LoggedModelPort implements ModelPort {
  readonly port: PortName;
  readonly modelId: string;
  private readonly invoke: RawInvoker;
  private readonly logger: CallLogger;
  private readonly now: () => Date;
  private readonly retry: RetryPolicy;
  constructor(port: PortName, modelId: string, invoke: RawInvoker, logger: CallLogger, now: () => Date = () => new Date(), retry: RetryPolicy = DEFAULT_RETRY) {
    this.port = port;
    this.modelId = modelId;
    this.invoke = invoke;
    this.logger = logger;
    this.now = now;
    this.retry = retry;
  }

  async call(req: ModelRequest): Promise<ModelResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(req);
      } catch (e) {
        const transient = e instanceof ModelCallError && e.kind === "exit" && !(e instanceof SchemaValidationError);
        if (!transient || attempt >= this.retry.transientRetries) throw e;
        if (this.retry.delayMs > 0) await new Promise((r) => setTimeout(r, this.retry.delayMs));
      }
    }
  }

  private async callOnce(req: ModelRequest): Promise<ModelResult> {
    const at = this.now();
    const t0 = performance.now();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let raw: RawCallResult | undefined;
    try {
      raw = await this.invoke({ ...req, timeoutMs });
      const v = validateAgainst(req.schema, raw.output);
      if (!v.ok) throw new SchemaValidationError(this.port, raw.modelId, v.errors, v.summary);
      const durationMs = performance.now() - t0;
      this.log(req, at, durationMs, raw);
      return {
        output: raw.output,
        modelId: raw.modelId,
        reportedModelId: raw.reportedModelId,
        toolEvents: raw.toolEvents,
        durationMs: Math.round(durationMs),
        tokens: raw.tokens,
        costUsd: raw.costUsd,
        raw: raw.raw,
      };
    } catch (e) {
      const err =
        e instanceof ModelCallError
          ? e
          : new ModelCallError("exit", this.port, this.modelId, e instanceof Error ? e.message : String(e));
      this.log(req, at, performance.now() - t0, raw, err);
      throw err;
    }
  }

  private log(req: ModelRequest, at: Date, durationMs: number, raw?: RawCallResult, error?: ModelCallError): void {
    const line = buildCallLogLine({
      at,
      task: req.task,
      port: this.port,
      requestedModelId: this.modelId,
      reportedModelId: raw?.reportedModelId ?? null,
      jobId: req.jobId,
      tools: req.tools ?? "none",
      toolEvents: raw?.toolEvents,
      prompt: req.prompt,
      schema: req.schema,
      durationMs,
      tokens: raw?.tokens,
      costUsd: raw?.costUsd,
      raw: raw?.raw,
      error: error ? `${error.kind}: ${stripPrefix(error.message)}` : undefined,
    });
    try {
      this.logger.append(line, at);
    } catch (logErr) {
      // Logging must never mask the call outcome, but make the failure visible.
      process.stderr.write(`sfsh: failed to write call log: ${String(logErr)}\n`);
    }
  }
}

function stripPrefix(msg: string): string {
  return msg.replace(/^\[[^\]]*\] [a-z_]+: /, "");
}
