/**
 * `/sfsh` interaction handler (WP-4.4, REQUIREMENTS §4.2). A thin layer: permission check → SfshService → reply text.
 * It never runs the pipeline and never pastes generated page text (the service returns short status texts).
 *
 * Permission order:
 *  (a) user not in the allow list (owner ∪ allowed_user_ids) → record in the reject log (reason not_allowed) and an
 *      EPHEMERAL short refusal (decision: Discord shows "the application did not respond" when an interaction gets no
 *      reply, so "無視" is realised as a reply only the sender can see, revealing nothing about SFSH). Service not called.
 *  (b) hold / release / takedown by a non-owner → record (owner_only) + ephemeral refusal. Service not called.
 *  (c) everything else → service; cancel's "submitter or owner" check is the service's; a not_permitted answer is
 *      recorded too (reason not_permitted).
 */
import fs from "node:fs";
import path from "node:path";
import { isoLocal } from "../model/callLog.ts";
import { JOB_ID_RE } from "../queue/store.ts";
import type { Actor, OpResult, Requester, SfshService } from "../queue/types.ts";
import { allowedUserIds, DEFAULT_REJECT_LOG, isOwner, type DiscordConfig } from "./config.ts";
import { OWNER_ONLY_SUBCOMMANDS } from "./commands.ts";

export const DISCORD_MAX_CONTENT = 2000;

// ---------------------------------------------------------------- interaction shapes (subset of Discord's payload)

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
}

export interface Interaction {
  id: string;
  application_id?: string;
  /** 1 PING, 2 APPLICATION_COMMAND, ... */
  type: number;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    options?: InteractionOption[];
    resolved?: { attachments?: Record<string, DiscordAttachment> };
  };
}

export interface HandlerReply {
  content: string;
  ephemeral: boolean;
}

// ---------------------------------------------------------------- reject log

export type RejectReason = "not_allowed" | "owner_only" | "not_permitted";

export interface RejectRecord {
  at: string;
  user_id: string;
  user_name: string;
  guild_id: string | null;
  channel_id: string | null;
  command: string;
  options: Record<string, string>;
  reason: RejectReason;
}

export interface RejectLog {
  write(rec: RejectRecord): void;
}

/** Append-only JSONL reject log (default logs/discord/rejected.jsonl). */
export function fileRejectLog(file: string = DEFAULT_REJECT_LOG): RejectLog {
  return {
    write(rec) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    },
  };
}

// ---------------------------------------------------------------- attachments

export type FetchAttachment = (url: string, maxBytes: number) => Promise<Uint8Array>;

export class AttachmentTooLargeError extends Error {
  maxBytes: number;
  constructor(maxBytes: number) {
    super(`添付ファイルが大きすぎます（上限 ${maxBytes} バイト）`);
    this.maxBytes = maxBytes;
  }
}

export interface AttachmentFetcherOptions {
  fetchImpl?: typeof fetch;
  /** Hosts the bot may download from (default: Discord's CDN only — no SSRF via a crafted url). */
  allowedHosts?: string[];
  /** Allow http: (tests against 127.0.0.1 only). */
  allowHttp?: boolean;
}

/** Streaming download with a hard byte cap (stops reading as soon as the cap is exceeded). */
export function createAttachmentFetcher(opts: AttachmentFetcherOptions = {}): FetchAttachment {
  const hosts = opts.allowedHosts ?? ["cdn.discordapp.com", "media.discordapp.net"];
  const f = opts.fetchImpl ?? fetch;
  return async (url, maxBytes) => {
    const u = new URL(url);
    if (!(u.protocol === "https:" || (opts.allowHttp && u.protocol === "http:"))) throw new Error(`添付の URL を受け付けません: ${u.protocol}`);
    if (!hosts.includes(u.hostname)) throw new Error(`添付の取得元を受け付けません: ${u.hostname}`);
    const res = await f(u, { redirect: "error" });
    if (!res.ok) throw new Error(`添付ファイルを取得できません（HTTP ${res.status}）`);
    const len = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(len) && len > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new AttachmentTooLargeError(maxBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AttachmentTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  };
}

// ---------------------------------------------------------------- helpers

/** Cut to ≤ max UTF-16 units (Discord's 2000 limit) without splitting a surrogate pair. */
export function truncateForDiscord(text: string, max: number = DISCORD_MAX_CONTENT): string {
  if (text.length <= max) return text;
  const tail = "\n…（以下省略）";
  let cut = max - tail.length;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--; // high surrogate at the edge: drop it too
  return text.slice(0, cut) + tail;
}

function userOf(i: Interaction): { id: string; name: string } {
  const u = i.member?.user ?? i.user;
  return { id: u?.id ?? "", name: (u?.global_name || u?.username || "").slice(0, 100) };
}

function subcommandOf(i: Interaction): { name: string; opts: Map<string, string | number | boolean> } {
  const top = i.data?.options?.[0];
  const opts = new Map<string, string | number | boolean>();
  if (!top || top.type !== 1) return { name: "", opts };
  for (const o of top.options ?? []) if (o.value !== undefined) opts.set(o.name, o.value);
  return { name: top.name, opts };
}

function summarizeOptions(i: Interaction, opts: Map<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of opts) {
    let s = String(v);
    if (k === "file") s = i.data?.resolved?.attachments?.[s]?.filename ?? "(attachment)";
    out[k] = s.length > 100 ? s.slice(0, 100) + "…" : s;
  }
  return out;
}

const s = (v: string | number | boolean | undefined): string | null => (v === undefined || v === null ? null : String(v).trim() || null);

// ---------------------------------------------------------------- handler

export interface HandlerContext {
  cfg: DiscordConfig;
  service: SfshService;
  log: RejectLog;
  fetchAttachment: FetchAttachment;
  now?: () => Date;
}

const REFUSE_NOT_ALLOWED = "このコマンドを使う権限がありません。";
const REFUSE_OWNER_ONLY = "このコマンドはオーナーだけが実行できます。";

/** Whether a subcommand's normal reply is only shown to the sender (status/queue: avoid channel noise). */
export function prefersEphemeral(sub: string): boolean {
  return sub === "status" || sub === "queue";
}

/** Returns null for interactions that are not `/sfsh` application commands (nothing to reply). */
export async function handleInteraction(i: Interaction, ctx: HandlerContext): Promise<HandlerReply | null> {
  if (i.type !== 2 || i.data?.name !== "sfsh") return null;
  const now = ctx.now ?? (() => new Date());
  const user = userOf(i);
  const { name: sub, opts } = subcommandOf(i);
  const reject = (reason: RejectReason) =>
    ctx.log.write({
      at: isoLocal(now()),
      user_id: user.id,
      user_name: user.name,
      guild_id: i.guild_id ?? null,
      channel_id: i.channel_id ?? null,
      command: `sfsh ${sub}`.trim(),
      options: summarizeOptions(i, opts),
      reason,
    });
  const reply = (content: string, ephemeral: boolean): HandlerReply => ({ content: truncateForDiscord(content), ephemeral });

  // (a) allow list
  if (!user.id || !allowedUserIds(ctx.cfg).has(user.id)) {
    reject("not_allowed");
    return reply(REFUSE_NOT_ALLOWED, true);
  }
  const owner = isOwner(ctx.cfg, user.id);
  // (b) owner-only
  if ((OWNER_ONLY_SUBCOMMANDS as readonly string[]).includes(sub) && !owner) {
    reject("owner_only");
    return reply(REFUSE_OWNER_ONLY, true);
  }

  const requester: Requester = { id: user.id, name: user.name };
  const actor: Actor = { id: user.id, name: user.name, origin: "discord", is_owner: owner };
  const replyTo = i.channel_id ?? null;
  const fromResult = (r: OpResult, ephemeralOk = prefersEphemeral(sub)): HandlerReply => reply(r.text || (r.ok ? "完了しました。" : "失敗しました。"), r.ok ? ephemeralOk : true);

  try {
    switch (sub) {
      case "request": {
        const work = s(opts.get("work"));
        if (!work) return reply("work（作品名）を指定してください。", true);
        return fromResult(
          ctx.service.request({ origin: "discord", requester, reply_to: replyTo, work, range: s(opts.get("range")), medium: s(opts.get("medium")), note: s(opts.get("note")) }),
        );
      }
      case "import": {
        const attId = s(opts.get("file"));
        const att = attId ? i.data?.resolved?.attachments?.[attId] : undefined;
        if (!att) return reply("添付ファイルが見つかりません。", true);
        if (!/\.(txt|csv)$/i.test(att.filename)) return reply("添付できるのは .txt と .csv だけです。", true);
        const max = ctx.cfg.attachment_max_bytes;
        if (typeof att.size === "number" && att.size > max) return reply(`添付ファイルが大きすぎます（上限 ${max} バイト）。`, true);
        let bytes: Uint8Array;
        try {
          bytes = await ctx.fetchAttachment(att.url, max);
        } catch (e) {
          return reply(e instanceof AttachmentTooLargeError ? `${e.message}。` : `添付ファイルを取得できませんでした: ${(e as Error).message}`, true);
        }
        return fromResult(
          ctx.service.importFile({ fileName: att.filename, bytes, range: s(opts.get("range")), medium: s(opts.get("medium")), priority: null, origin: "discord", requester, reply_to: replyTo }),
        );
      }
      case "status": {
        const id = s(opts.get("id"));
        return fromResult(ctx.service.status(id === null ? {} : JOB_ID_RE.test(id) ? { job_id: id } : { batch_id: id }));
      }
      case "queue":
        return fromResult(ctx.service.queue());
      case "cancel": {
        const job_id = s(opts.get("job_id"));
        const batch_id = s(opts.get("batch_id"));
        if ((job_id === null) === (batch_id === null)) return reply("job_id か batch_id のどちらか一方を指定してください。", true);
        const r = ctx.service.cancel(job_id ? { job_id } : { batch_id: batch_id! }, actor);
        if (!r.ok && (r.data as { reason?: unknown } | undefined)?.reason === "not_permitted") reject("not_permitted");
        return fromResult(r);
      }
      case "answer": {
        const job_id = s(opts.get("job_id"));
        if (!job_id) return reply("job_id を指定してください。", true);
        const pickRaw = opts.get("pick");
        const ans: { pick?: number; work?: string; medium?: string; range?: string } = {};
        if (pickRaw !== undefined) ans.pick = Number(pickRaw);
        for (const k of ["work", "medium", "range"] as const) {
          const v = s(opts.get(k));
          if (v !== null) ans[k] = v;
        }
        if (Object.keys(ans).length === 0) return reply("pick・work・medium・range のどれかを指定してください。", true);
        return fromResult(ctx.service.answer(job_id, ans, actor));
      }
      case "hold":
      case "release":
      case "takedown": {
        const work = s(opts.get("work"));
        if (!work) return reply("work（work_id）を指定してください。", true);
        const reason = s(opts.get("reason"));
        return fromResult(await ctx.service[sub](work, reason, actor));
      }
      default:
        return reply(`不明なサブコマンドです: ${sub || "(なし)"}`, true);
    }
  } catch (e) {
    return reply(`処理中にエラーが起きました: ${(e as Error).message}`, true);
  }
}
