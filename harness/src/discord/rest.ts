/**
 * Minimal Discord REST client (v10). Only what the bot needs: post a message, answer an interaction, edit the deferred
 * answer, bulk-overwrite commands. `apiBase` is injectable so every test points at a 127.0.0.1 mock.
 * Mentions are always disabled (allowed_mentions.parse = []) so a work title like "@everyone" pings nobody.
 */
import { truncateForDiscord, type HandlerReply } from "./handler.ts";
import type { ApplicationCommand } from "./commands.ts";

export class DiscordHttpError extends Error {
  status: number;
  /** Set on 429: milliseconds to wait (from body retry_after or the Retry-After header). */
  retryAfterMs: number | null;
  body: string;
  constructor(method: string, route: string, status: number, body: string, retryAfterMs: number | null) {
    super(`Discord ${method} ${route} → HTTP ${status}${retryAfterMs !== null ? ` (retry after ${retryAfterMs} ms)` : ""}`);
    this.status = status;
    this.body = body.slice(0, 500);
    this.retryAfterMs = retryAfterMs;
  }
}

export interface DiscordRest {
  postMessage(channelId: string, content: string): Promise<unknown>;
  /** type 4 (CHANNEL_MESSAGE_WITH_SOURCE) or, with `deferred`, type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE). */
  interactionCallback(interactionId: string, interactionToken: string, reply: HandlerReply, deferred?: boolean): Promise<unknown>;
  /** PATCH the original (deferred) response. */
  editOriginal(applicationId: string, interactionToken: string, content: string): Promise<unknown>;
  putCommands(applicationId: string, guildId: string | null, defs: ApplicationCommand[]): Promise<unknown>;
}

export interface RestOptions {
  apiBase: string;
  token: string | null;
  fetchImpl?: typeof fetch;
}

const EPHEMERAL = 64;
const NO_MENTIONS = { parse: [] as string[] };
const seg = (v: string) => encodeURIComponent(v);

/** 429 wait in ms: JSON body `retry_after` (seconds, float) first, then the Retry-After header (seconds). */
export function parseRetryAfter(body: string, header: string | null): number | null {
  try {
    const j = JSON.parse(body) as { retry_after?: unknown };
    if (typeof j.retry_after === "number" && j.retry_after >= 0) return Math.ceil(j.retry_after * 1000);
  } catch {
    /* not JSON */
  }
  if (header !== null && header.trim() !== "" && Number.isFinite(Number(header))) return Math.ceil(Number(header) * 1000);
  return null;
}

export function createRest(opts: RestOptions): DiscordRest {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.apiBase.replace(/\/+$/, "");

  async function call(method: string, route: string, body: unknown, auth = true): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/sfsh-private, 0.0.1)",
    };
    if (auth) {
      if (!opts.token) throw new Error("Discord token is not configured");
      headers.Authorization = `Bot ${opts.token}`;
    }
    const res = await f(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new DiscordHttpError(method, route, res.status, text, res.status === 429 ? (parseRetryAfter(text, res.headers.get("retry-after")) ?? 1000) : null);
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return {
    postMessage(channelId, content) {
      return call("POST", `/channels/${seg(channelId)}/messages`, { content: truncateForDiscord(content), allowed_mentions: NO_MENTIONS });
    },
    interactionCallback(interactionId, interactionToken, reply, deferred = false) {
      const flags = reply.ephemeral ? EPHEMERAL : 0;
      const body = deferred ? { type: 5, data: { flags } } : { type: 4, data: { content: truncateForDiscord(reply.content), flags, allowed_mentions: NO_MENTIONS } };
      // Interaction endpoints are authenticated by the interaction token in the path, not the bot token.
      return call("POST", `/interactions/${seg(interactionId)}/${seg(interactionToken)}/callback`, body, false);
    },
    editOriginal(applicationId, interactionToken, content) {
      return call("PATCH", `/webhooks/${seg(applicationId)}/${seg(interactionToken)}/messages/@original`, { content: truncateForDiscord(content), allowed_mentions: NO_MENTIONS }, false);
    },
    putCommands(applicationId, guildId, defs) {
      const route = guildId ? `/applications/${seg(applicationId)}/guilds/${seg(guildId)}/commands` : `/applications/${seg(applicationId)}/commands`;
      return call("PUT", route, defs);
    },
  };
}
