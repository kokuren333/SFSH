/**
 * Bot runner (WP-4.4): gateway → INTERACTION_CREATE → handleInteraction → interaction callback, plus a timer that
 * delivers outbox notices. The bot only touches queue files through SfshService and the outbox (§4.2 thin layer):
 * if it dies the worker keeps running; if the worker dies instructions are not lost.
 *
 * Discord wants an interaction answered within 3 s. The handler is raced against `deferAfterMs` (default 2 s): if it is
 * slower (e.g. takedown rebuilds the site) a deferred response (type 5) is sent and the result is PATCHed onto it.
 *
 * startBot() does NOT check production permission; callers (commands/discord.ts) must call assertProductionAllowed first.
 */
import type { QueueEnv } from "../queue/store.ts";
import type { SfshService } from "../queue/types.ts";
import type { DiscordConfig } from "./config.ts";
import { createGateway, realTimers, type GatewayClient, type GatewayTimers, type SocketFactory } from "./gateway.ts";
import { createAttachmentFetcher, fileRejectLog, handleInteraction, prefersEphemeral, type FetchAttachment, type HandlerReply, type Interaction, type RejectLog } from "./handler.ts";
import { createNotifierState, deliverNotices, type DeliverResult } from "./notifier.ts";
import { createRest, type DiscordRest } from "./rest.ts";

export interface BotOptions {
  cfg: DiscordConfig;
  service: SfshService;
  queueEnv: QueueEnv;
  rest?: DiscordRest;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  timers?: GatewayTimers;
  random?: () => number;
  rejectLog?: RejectLog;
  fetchAttachment?: FetchAttachment;
  now?: () => Date;
  noticeIntervalMs?: number;
  deferAfterMs?: number;
  log?: (msg: string) => void;
}

export interface Bot {
  gateway: GatewayClient;
  /** Run one notice-delivery round now (also used by the timer). */
  deliverNow(): Promise<DeliverResult | null>;
  /** Resolves when every interaction received so far has been answered (tests). */
  idle(): Promise<void>;
  stop(): void;
}

export function startBot(o: BotOptions): Bot {
  const log = o.log ?? ((m: string) => console.error(m));
  const timers = o.timers ?? realTimers;
  const now = o.now ?? (() => new Date());
  const rest = o.rest ?? createRest({ apiBase: o.cfg.api_base, token: o.cfg.token, fetchImpl: o.fetchImpl });
  const ctx = {
    cfg: o.cfg,
    service: o.service,
    log: o.rejectLog ?? fileRejectLog(),
    fetchAttachment: o.fetchAttachment ?? createAttachmentFetcher({ fetchImpl: o.fetchImpl }),
    now,
  };
  const deferAfter = o.deferAfterMs ?? 2000;
  const inflight = new Set<Promise<void>>();

  async function answer(i: Interaction): Promise<void> {
    if (!i || typeof i !== "object" || !i.id || !i.token) return;
    const work = handleInteraction(i, ctx);
    let timer: unknown = null;
    const raced = await Promise.race([
      work.then((r) => ({ done: true as const, r })),
      new Promise<{ done: false }>((res) => {
        timer = timers.setTimeout(() => res({ done: false }), deferAfter);
      }),
    ]);
    if (timer !== null) timers.clearTimeout(timer);
    if (raced.done) {
      if (raced.r) await rest.interactionCallback(i.id, i.token, raced.r);
      return;
    }
    const sub = i.data?.options?.[0]?.name ?? "";
    await rest.interactionCallback(i.id, i.token, { content: "", ephemeral: prefersEphemeral(sub) }, true);
    const r: HandlerReply | null = await work;
    if (i.application_id) await rest.editOriginal(i.application_id, i.token, r?.content ?? "完了しました。");
  }

  const gateway = createGateway({
    url: o.cfg.gateway_url,
    token: o.cfg.token ?? "",
    socketFactory: o.socketFactory,
    timers,
    random: o.random,
    log,
    onReady: (d) => log(`discord: ready as ${d.user?.username ?? "?"}`),
    onFatal: (code) => log(`discord: gateway closed with fatal code ${code}; not reconnecting`),
    onInteraction: (d) => {
      const p = answer(d as Interaction).catch((e) => log(`discord: failed to answer interaction: ${(e as Error).message}`));
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
  });

  const nstate = createNotifierState();
  let delivering = false;
  async function deliverNow(): Promise<DeliverResult | null> {
    if (delivering) return null;
    delivering = true;
    try {
      const r = await deliverNotices(o.queueEnv, rest, now(), nstate);
      if (r.failed) log(`discord: ${r.failed} notice(s) failed, will retry`);
      if (r.retryAfterMs !== null) log(`discord: rate limited, waiting ${r.retryAfterMs} ms`);
      return r;
    } catch (e) {
      log(`discord: notice delivery failed: ${(e as Error).message}`);
      return null;
    } finally {
      delivering = false;
    }
  }
  const noticeTimer = timers.setInterval(() => void deliverNow(), o.noticeIntervalMs ?? 5000);

  gateway.start();
  return {
    gateway,
    deliverNow,
    async idle() {
      while (inflight.size) await Promise.all([...inflight]);
    },
    stop() {
      timers.clearInterval(noticeTimer);
      gateway.stop();
    },
  };
}
