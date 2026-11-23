/**
 * Discord bot configuration (WP-4.4, REQUIREMENTS §4.2, PLAN §4).
 *
 * - Non-secret settings live in harness/config/discord.json (tracked).
 * - The bot token comes from env DISCORD_BOT_TOKEN, or from `.env` at the repo root (git-ignored, parsed minimally).
 * - Production connection is refused unless `production_enabled === true` AND a token AND owner_id are present
 *   (U-04: the client decides when/where the bot runs; until then the default config cannot connect).
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";

export interface DiscordConfig {
  /** Discord user id (snowflake, string) of the owner; null until U-04. */
  owner_id: string | null;
  /** Extra allowed user ids. Allowed set = owner ∪ allowed_user_ids. */
  allowed_user_ids: string[];
  api_base: string;
  gateway_url: string;
  application_id: string | null;
  /** Guild for guild-scoped command registration (null → global commands). */
  guild_id: string | null;
  production_enabled: boolean;
  attachment_max_bytes: number;
  /** Bot token (from env / .env). Never written to logs or printed. */
  token: string | null;
}

export const DEFAULT_DISCORD_CONFIG: Omit<DiscordConfig, "token"> = {
  owner_id: null,
  allowed_user_ids: [],
  api_base: "https://discord.com/api/v10",
  gateway_url: "wss://gateway.discord.gg/?v=10&encoding=json",
  application_id: null,
  guild_id: null,
  production_enabled: false,
  attachment_max_bytes: 1048576,
};

export const DISCORD_CONFIG_PATH = path.join(paths.root, "harness", "config", "discord.json");
export const DOTENV_PATH = path.join(paths.root, ".env");
export const DEFAULT_REJECT_LOG = path.join(paths.root, "logs", "discord", "rejected.jsonl");

/** Minimal .env parser: `KEY=value`, `export KEY=value`, `#` comments, optional single/double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]!] = v;
  }
  return out;
}

function idOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  // Snowflakes exceed 2^53: a JSON number would silently lose digits.
  if (typeof v !== "string") throw new Error(`discord.json: ${field} は文字列で書いてください（数値だと桁が失われます）`);
  if (!/^\d{1,25}$/.test(v)) throw new Error(`discord.json: ${field} が Discord の ID の形ではありません: ${v}`);
  return v;
}

/** Validate a raw JSON object into a config (token supplied separately). */
export function parseDiscordConfig(raw: unknown, token: string | null): DiscordConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("discord.json: JSON object expected");
  const r = { ...DEFAULT_DISCORD_CONFIG, ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  const allowed = r.allowed_user_ids;
  if (!Array.isArray(allowed)) throw new Error("discord.json: allowed_user_ids は配列です");
  const max = r.attachment_max_bytes;
  if (typeof max !== "number" || !Number.isInteger(max) || max <= 0) throw new Error("discord.json: attachment_max_bytes は正の整数です");
  if (typeof r.api_base !== "string" || !/^https?:\/\//.test(r.api_base)) throw new Error("discord.json: api_base は http(s) URL です");
  if (typeof r.gateway_url !== "string" || !/^wss?:\/\//.test(r.gateway_url)) throw new Error("discord.json: gateway_url は ws(s) URL です");
  return {
    owner_id: idOrNull(r.owner_id, "owner_id"),
    allowed_user_ids: allowed.map((v, i) => idOrNull(v, `allowed_user_ids[${i}]`)).filter((v): v is string => v !== null),
    api_base: r.api_base.replace(/\/+$/, ""),
    gateway_url: r.gateway_url,
    application_id: idOrNull(r.application_id, "application_id"),
    guild_id: idOrNull(r.guild_id, "guild_id"),
    production_enabled: r.production_enabled === true,
    attachment_max_bytes: max,
    token: token && token.trim() ? token.trim() : null,
  };
}

export interface LoadConfigOptions {
  configPath?: string;
  /** Environment to read DISCORD_BOT_TOKEN from (default process.env). */
  env?: Record<string, string | undefined>;
  /** .env file (default <repo>/.env); pass null to skip reading any .env. */
  dotenvPath?: string | null;
}

/** Read discord.json + token. A missing discord.json means the defaults (cannot connect). */
export function loadDiscordConfig(opts: LoadConfigOptions = {}): DiscordConfig {
  const file = opts.configPath ?? DISCORD_CONFIG_PATH;
  const raw = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as unknown) : {};
  const env = opts.env ?? process.env;
  let token = env.DISCORD_BOT_TOKEN ?? null;
  const dotenv = opts.dotenvPath === undefined ? DOTENV_PATH : opts.dotenvPath;
  if (!token && dotenv && fs.existsSync(dotenv)) token = parseDotenv(fs.readFileSync(dotenv, "utf8")).DISCORD_BOT_TOKEN ?? null;
  return parseDiscordConfig(raw, token);
}

/** owner ∪ allowed_user_ids (default: owner only; empty when nothing is configured → everybody is refused). */
export function allowedUserIds(cfg: DiscordConfig): Set<string> {
  const s = new Set<string>(cfg.allowed_user_ids);
  if (cfg.owner_id) s.add(cfg.owner_id);
  return s;
}

export function isOwner(cfg: DiscordConfig, userId: string): boolean {
  return cfg.owner_id !== null && userId === cfg.owner_id;
}

/** Throws (Japanese, mentions U-04) unless production use is explicitly enabled and complete. */
export function assertProductionAllowed(cfg: DiscordConfig): void {
  const missing: string[] = [];
  if (cfg.production_enabled !== true) missing.push("harness/config/discord.json の production_enabled が true ではありません");
  if (!cfg.token) missing.push("ボットのトークン（環境変数または .env の DISCORD_BOT_TOKEN）がありません");
  if (!cfg.owner_id) missing.push("harness/config/discord.json の owner_id が未設定です");
  if (missing.length) {
    throw new Error(
      `Discord 本番への接続を拒否しました（U-04: 稼働場所・サーバー・チャンネルは発注者の指示待ちです）。\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\n発注者の指示（U-04）を受けてから設定してください。`,
    );
  }
}

/** Config summary safe to print (token masked). */
export function configSummary(cfg: DiscordConfig): Record<string, unknown> {
  return {
    owner_id: cfg.owner_id,
    allowed_user_ids: [...allowedUserIds(cfg)],
    api_base: cfg.api_base,
    gateway_url: cfg.gateway_url,
    application_id: cfg.application_id,
    guild_id: cfg.guild_id,
    production_enabled: cfg.production_enabled,
    attachment_max_bytes: cfg.attachment_max_bytes,
    token: cfg.token ? `set (${cfg.token.length} chars)` : "missing",
  };
}
