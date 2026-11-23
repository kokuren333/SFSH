/** ModelPort abstraction (REQUIREMENTS §1.2-4). All model calls go through this interface. */

export type PortName = "haiku" | "luna";

export interface ModelRequest {
  /** Logical task name, e.g. "s1.claims" or "models.probe". Logged. */
  task: string;
  /** Prompt body. Never logged (only its sha256 and length). */
  prompt: string;
  /** JSON Schema the output must satisfy. For luna it must be OpenAI-strict. */
  schema: object;
  timeoutMs?: number;
  /**
   * Model-side tools. "none" (default) = no tools at all (luna: web_search disabled AND the codex
   * apps/browser/computer-use fallbacks disabled; haiku: --tools ""). "web_search" = luna only:
   * the structured web_search tool, whose results are captured as events (REQUIREMENTS 1.3-1).
   */
  tools?: ToolMode;
  /** Job id for observability (7.3). Logged. */
  jobId?: string;
}

export type ToolMode = "none" | "web_search";

/** One completed codex web_search item (search or open_page), as captured from --json events. */
export interface WebSearchEvent {
  itemId: string;
  action: "search" | "open_page" | "other";
  query: string | null;
  url: string | null;
  results: { url: string; title: string; domain: string; snippet: string }[];
}

/** Model-side tool activity observed in a call. */
export interface ToolEvents {
  webSearch: WebSearchEvent[];
  /** Count of other tool items (mcp_tool_call, command_execution, ...). Expected 0. */
  otherToolItems: number;
  otherToolTypes: string[];
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface ModelResult {
  output: unknown;
  /** Effective model id = reportedModelId ?? requested id. */
  modelId: string;
  /** Model id reported by the CLI itself (haiku: modelUsage keys). null when the CLI reports none (luna). */
  reportedModelId: string | null;
  /** Tool activity (luna). Present for luna calls. */
  toolEvents?: ToolEvents;
  durationMs: number;
  tokens: TokenUsage;
  costUsd?: number | null;
  /** Raw model text (the JSON string returned). Not logged. */
  raw?: string;
}

export interface ModelPort {
  readonly port: PortName;
  /** Model id requested from the backend. */
  readonly modelId: string;
  call(req: ModelRequest): Promise<ModelResult>;
}

export type ModelErrorKind =
  | "spawn" // CLI could not be started
  | "timeout" // exceeded timeoutMs
  | "exit" // CLI exited non-zero / reported an error
  | "model_not_found" // backend says the model id is unavailable
  | "parse" // could not parse CLI envelope or output JSON
  | "schema_invalid" // output parsed but failed JSON Schema validation
  | "bad_request"; // request rejected before calling (e.g. non-strict schema for luna)

export class ModelCallError extends Error {
  readonly kind: ModelErrorKind;
  readonly port: PortName;
  readonly modelId: string;
  readonly details?: unknown;
  constructor(kind: ModelErrorKind, port: PortName, modelId: string, message: string, details?: unknown) {
    super(`[${port}:${modelId}] ${kind}: ${message}`);
    this.name = "ModelCallError";
    this.kind = kind;
    this.port = port;
    this.modelId = modelId;
    this.details = details;
  }
}

export class SchemaValidationError extends ModelCallError {
  readonly errors: unknown[];
  constructor(port: PortName, modelId: string, errors: unknown[], summary: string) {
    super("schema_invalid", port, modelId, summary, errors);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

/** What a backend (CLI transport) returns before validation/logging. */
export interface RawCallResult {
  output: unknown;
  raw: string;
  /** Effective model id = reportedModelId ?? requested id. */
  modelId: string;
  /** Model id reported by the CLI (null = CLI reports none). */
  reportedModelId: string | null;
  toolEvents?: ToolEvents;
  tokens: TokenUsage;
  costUsd: number | null;
}

/** Backend transport: performs exactly one model round trip. Throws ModelCallError on failure. */
export type RawInvoker = (req: ModelRequest & { timeoutMs: number }) => Promise<RawCallResult>;
