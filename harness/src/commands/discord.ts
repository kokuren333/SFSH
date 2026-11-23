/**
 * `sfsh discord commands`              print the /sfsh application-command JSON
 * `sfsh discord serve [--dry-run]`     run the bot (gateway + notice delivery). Refused (exit 2) unless
 *                                      assertProductionAllowed passes (U-04). --dry-run prints the config summary only.
 * `sfsh discord register`              PUT the command JSON (guild-scoped when guild_id is set). Same gate.
 * Exit: 0 ok / 2 usage or refused by the production gate / 3 failed.
 *
 * Not registered in cli.ts by this package (the orchestrator registers it). The real SfshService is supplied by
 * `deps.service`, or — when absent — loaded from `../queue/service.ts` export `createSfshService(env?)`.
 */
import { defaultQueueEnv, type QueueEnv } from "../queue/store.ts";
import type { SfshService } from "../queue/types.ts";
import { startBot } from "../discord/bot.ts";
import { commandDefinitions } from "../discord/commands.ts";
import { assertProductionAllowed, configSummary, loadDiscordConfig, type DiscordConfig } from "../discord/config.ts";
import type { SocketFactory } from "../discord/gateway.ts";
import { createRest } from "../discord/rest.ts";

export interface DiscordCommandDeps {
  loadConfig?: () => DiscordConfig;
  service?: SfshService | (() => SfshService | Promise<SfshService>);
  queueEnv?: QueueEnv;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** serve: resolves when the bot should stop (default: SIGINT/SIGTERM). */
  until?: Promise<void>;
}

const USAGE = "usage: sfsh discord commands | discord serve [--dry-run] | discord register";

async function resolveService(deps: DiscordCommandDeps, env: QueueEnv): Promise<SfshService> {
  if (deps.service) return typeof deps.service === "function" ? await deps.service() : deps.service;
  const spec = "../queue/service.ts"; // variable specifier: wired by the orchestrator, not resolved at type-check time
  const mod = (await import(spec)) as { createSfshService?: (env?: QueueEnv) => SfshService | Promise<SfshService> };
  if (typeof mod.createSfshService !== "function") throw new Error("queue/service.ts に createSfshService がありません");
  return await mod.createSfshService(env);
}

function waitForSignal(): Promise<void> {
  return new Promise((res) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      res();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

export async function discordCommand(args: string[], deps: DiscordCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const [sub, ...rest] = args;

  if (sub === "commands") {
    out(JSON.stringify(commandDefinitions(), null, 2));
    return 0;
  }
  if (sub !== "serve" && sub !== "register") {
    err(USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const unknown = rest.filter((a) => a !== "--dry-run" || sub !== "serve");
  if (unknown.length) {
    err(`unknown option: ${unknown.join(" ")}\n${USAGE}`);
    return 2;
  }

  let cfg: DiscordConfig;
  try {
    cfg = (deps.loadConfig ?? (() => loadDiscordConfig()))();
  } catch (e) {
    err(`discord: 設定を読めません: ${(e as Error).message}`);
    return 2;
  }

  if (dryRun) {
    out(JSON.stringify(configSummary(cfg), null, 2));
    try {
      assertProductionAllowed(cfg);
      out("dry-run: 本番接続の条件は満たしています（接続はしていません）。");
    } catch (e) {
      out(`dry-run: ${(e as Error).message}`);
    }
    return 0;
  }

  try {
    assertProductionAllowed(cfg);
  } catch (e) {
    err((e as Error).message);
    err("Discord には接続しません。");
    return 2;
  }

  if (sub === "register") {
    if (!cfg.application_id) {
      err("discord register: harness/config/discord.json の application_id が未設定です。");
      return 2;
    }
    try {
      await createRest({ apiBase: cfg.api_base, token: cfg.token, fetchImpl: deps.fetchImpl }).putCommands(cfg.application_id, cfg.guild_id, commandDefinitions());
      out(`discord register: /sfsh を登録しました（${cfg.guild_id ? `guild ${cfg.guild_id}` : "global"}）。`);
      return 0;
    } catch (e) {
      err(`discord register: 失敗しました: ${(e as Error).message}`);
      return 3;
    }
  }

  const env = deps.queueEnv ?? defaultQueueEnv();
  let service: SfshService;
  try {
    service = await resolveService(deps, env);
  } catch (e) {
    err(`discord serve: サービスを用意できません: ${(e as Error).message}`);
    return 3;
  }
  const bot = startBot({ cfg, service, queueEnv: env, fetchImpl: deps.fetchImpl, socketFactory: deps.socketFactory, log: err });
  out("discord serve: 起動しました（Ctrl+C で停止）。");
  await (deps.until ?? waitForSignal());
  bot.stop();
  out("discord serve: 停止しました。");
  return 0;
}
