import fs from "node:fs";
import path from "node:path";
import { sha256Hex, stableStringify } from "../util/hash.ts";
import type { PortName, TokenUsage, ToolEvents, ToolMode } from "./types.ts";

/**
 * One line of logs/calls/<YYYYMMDD>.jsonl (REQUIREMENTS §1.2-4).
 * Never contains prompt or output bodies — only hashes and sizes.
 */
export interface CallLogLine {
  ts: string;
  task: string;
  /** Job id (null for ad-hoc calls such as models.probe). */
  jobId: string | null;
  port: PortName;
  /** Effective model id = reportedModelId ?? requestedModelId. */
  modelId: string;
  /** Model id the harness asked the CLI for (-m / --model). */
  requestedModelId: string;
  /** Model id the CLI itself reported (haiku: modelUsage). null = the CLI reported none (luna / codex). */
  reportedModelId: string | null;
  /** Where `modelId` came from: "cli_reported" or "requested" (CLI reported nothing). PM 所見 a (CP-014). */
  modelIdSource: "cli_reported" | "requested";
  /** Model-side tools enabled for the call. */
  tools: ToolMode;
  /** Number of web_search items with action=search / open_page observed (luna). */
  webSearches: number;
  openPages: number;
  promptHash: string;
  promptChars: number;
  schemaHash: string;
  outputChars: number | null;
  durationMs: number;
  tokens: TokenUsage;
  costUsd: number | null;
  ok: boolean;
  error: string | null;
}

export const CALL_LOG_KEYS: readonly (keyof CallLogLine)[] = [
  "ts",
  "task",
  "jobId",
  "port",
  "modelId",
  "requestedModelId",
  "reportedModelId",
  "modelIdSource",
  "tools",
  "webSearches",
  "openPages",
  "promptHash",
  "promptChars",
  "schemaHash",
  "outputChars",
  "durationMs",
  "tokens",
  "costUsd",
  "ok",
  "error",
];

const ERROR_MAX = 200;

export interface CallLogInput {
  at: Date;
  task: string;
  port: PortName;
  requestedModelId: string;
  /** Model id reported by the CLI (null/undefined = none reported). */
  reportedModelId?: string | null;
  jobId?: string;
  tools?: ToolMode;
  toolEvents?: ToolEvents;
  prompt: string;
  schema: object;
  durationMs: number;
  tokens?: TokenUsage;
  costUsd?: number | null;
  raw?: string;
  error?: unknown;
}

export function buildCallLogLine(i: CallLogInput): CallLogLine {
  const errMsg = i.error === undefined ? null : shortError(i.error);
  return {
    ts: isoLocal(i.at),
    task: i.task,
    jobId: i.jobId ?? null,
    port: i.port,
    modelId: i.reportedModelId ?? i.requestedModelId,
    requestedModelId: i.requestedModelId,
    reportedModelId: i.reportedModelId ?? null,
    modelIdSource: i.reportedModelId ? "cli_reported" : "requested",
    tools: i.tools ?? "none",
    webSearches: i.toolEvents?.webSearch.filter((e) => e.action === "search").length ?? 0,
    openPages: i.toolEvents?.webSearch.filter((e) => e.action === "open_page").length ?? 0,
    promptHash: "sha256:" + sha256Hex(i.prompt),
    promptChars: i.prompt.length,
    schemaHash: "sha256:" + sha256Hex(stableStringify(i.schema)),
    outputChars: i.raw === undefined ? null : i.raw.length,
    durationMs: Math.round(i.durationMs),
    tokens: i.tokens ?? {},
    costUsd: i.costUsd ?? null,
    ok: errMsg === null,
    error: errMsg,
  };
}

export function shortError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_MAX ? oneLine.slice(0, ERROR_MAX - 1) + "…" : oneLine;
}

/** Local-time ISO-8601 with offset, e.g. 2026-11-23T02:06:00+09:00. */
export function isoLocal(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`
  );
}

export function callLogFileFor(dir: string, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return path.join(dir, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.jsonl`);
}

export interface CallLogger {
  append(line: CallLogLine, at: Date): void;
}

export class FileCallLogger implements CallLogger {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  append(line: CallLogLine, at: Date): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(callLogFileFor(this.dir, at), JSON.stringify(line) + "\n", "utf8");
  }
}

export class MemoryCallLogger implements CallLogger {
  readonly lines: CallLogLine[] = [];
  append(line: CallLogLine): void {
    this.lines.push(line);
  }
}
