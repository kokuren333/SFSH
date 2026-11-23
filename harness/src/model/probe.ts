import { ModelCallError, type ModelPort, type PortName } from "./types.ts";
import type { ModelsConfig } from "./config.ts";

/** Trivial 1-round-trip probe (REQUIREMENTS §3.1). OpenAI-strict so it works for codex too. */
export const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;

export const PROBE_PROMPT = 'Respond with the JSON object {"ok": true} and nothing else.';

export interface ProbeAttempt {
  port: PortName;
  modelId: string;
  ok: boolean;
  /** Actual model id reported by the backend (ok only). */
  actualModelId?: string;
  durationMs: number;
  error?: string;
  /** Not tried because an earlier candidate already responded. */
  skipped?: boolean;
}

export interface ProbeOutcome {
  attempts: ProbeAttempt[];
  adopted: Partial<Record<PortName, string>>;
  /** Ports for which no candidate responded. */
  failed: PortName[];
}

export type PortFactory = (port: PortName, modelId: string) => ModelPort;

/**
 * For each port, try candidates in priority order; adopt the first one that returns a
 * schema-valid response. Never falls back to ids outside the configured list (no other tiers).
 */
export async function probeModels(
  config: Pick<ModelsConfig, "haiku" | "luna">,
  factory: PortFactory,
  opts: { ports?: PortName[]; timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const ports = opts.ports ?? (["luna", "haiku"] as PortName[]);
  const attempts: ProbeAttempt[] = [];
  const adopted: Partial<Record<PortName, string>> = {};
  const failed: PortName[] = [];
  for (const port of ports) {
    const candidates = config[port];
    for (const modelId of candidates) {
      if (adopted[port]) {
        attempts.push({ port, modelId, ok: false, durationMs: 0, skipped: true });
        continue;
      }
      const t0 = performance.now();
      try {
        const r = await factory(port, modelId).call({
          task: "models.probe",
          prompt: PROBE_PROMPT,
          schema: PROBE_SCHEMA,
          timeoutMs: opts.timeoutMs ?? 120_000,
        });
        attempts.push({ port, modelId, ok: true, actualModelId: r.modelId, durationMs: r.durationMs });
        adopted[port] = modelId;
      } catch (e) {
        const error = e instanceof ModelCallError ? `${e.kind}: ${e.message.replace(/^\[[^\]]*\] [a-z_]+: /, "")}` : String(e);
        attempts.push({ port, modelId, ok: false, durationMs: Math.round(performance.now() - t0), error: error.slice(0, 160) });
      }
    }
    if (!adopted[port]) failed.push(port);
  }
  return { attempts, adopted, failed };
}

export function formatProbeTable(o: ProbeOutcome): string {
  const rows = [["port", "model id", "result", "ms", "note"]];
  for (const a of o.attempts) {
    rows.push([
      a.port,
      a.modelId,
      a.skipped ? "skipped" : a.ok ? "OK" : "FAIL",
      a.skipped ? "-" : String(a.durationMs),
      a.skipped ? "earlier candidate adopted" : a.ok ? `actual=${a.actualModelId}` : (a.error ?? ""),
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [fmt(rows[0]), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(fmt)].join("\n");
}
