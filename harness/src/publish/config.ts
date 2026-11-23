/**
 * Publish configuration and the production gate (REQUIREMENTS §6.3-6, §5.3, U-05 / U-07; ledger CP-041, PLAN §1).
 *
 * harness/config/publish.json (tracked, no secrets). Credentials are never stored here: pushing to the real Pages
 * repository uses the machine's normal git credential helper, and only `sfsh publish` ever runs `git push`.
 *
 * Gate:
 *  - production_enabled === false (default, until the owner instructs the site opening): the only push target is
 *    `test_remote_url`, which must be a LOCAL path to an existing BARE repository (no URL scheme other than file://,
 *    no scp form, not the harness repository). Every git command on publish/ then also runs with
 *    `-c protocol.allow=never -c protocol.file.allow=always`, so git itself refuses any network transport.
 *  - production_enabled === true: the push target is `remote_url` (required). test_remote_url is ignored.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";

export interface PublishConfig {
  production_enabled: boolean;
  remote_url: string | null;
  test_remote_url: string;
  branch: string;
  mode: "auto" | "manual";
  base_url: string | null;
  test_base_url: string;
  commit_author: { name: string; email: string };
  url_check: { timeout_s: number; interval_s: number };
  /** Owner-approved email addresses the secret scan (c) lets through (U-10 if an email window is chosen). Default none. */
  allow_emails: string[];
}

export const DEFAULT_PUBLISH_CONFIG: PublishConfig = {
  production_enabled: false,
  remote_url: null,
  test_remote_url: "publish-test/site.git",
  branch: "main",
  mode: "auto",
  base_url: null,
  test_base_url: "https://sfsh-test.invalid/",
  commit_author: { name: "SFSH publisher", email: "sfsh-publisher@users.noreply.invalid" },
  url_check: { timeout_s: 600, interval_s: 15 },
  allow_emails: [],
};

export const PUBLISH_CONFIG_PATH = path.join(paths.root, "harness", "config", "publish.json");

export class PublishConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PublishConfigError";
  }
}

function str(v: unknown, field: string, allowNull: boolean): string | null {
  if (v === null || v === undefined) {
    if (allowNull) return null;
    throw new PublishConfigError(`publish.json: ${field} is required`);
  }
  if (typeof v !== "string" || !v.trim() || /[\r\n\0]/.test(v)) throw new PublishConfigError(`publish.json: ${field} must be a one-line string`);
  return v.trim();
}

function httpUrl(v: string | null, field: string): string | null {
  if (v === null) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new PublishConfigError(`publish.json: ${field} is not a URL`);
  }
  if (!["http:", "https:"].includes(u.protocol) || u.search || u.hash || u.username || u.password) throw new PublishConfigError(`publish.json: ${field} must be an http(s) URL without credentials/query/hash`);
  return u.href.endsWith("/") ? u.href : u.href + "/";
}

/** Validate a raw object (missing fields take defaults). */
export function parsePublishConfig(raw: unknown): PublishConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PUBLISH_CONFIG;
  if (r.production_enabled !== undefined && typeof r.production_enabled !== "boolean") throw new PublishConfigError("publish.json: production_enabled must be true/false");
  const mode = r.mode ?? d.mode;
  if (mode !== "auto" && mode !== "manual") throw new PublishConfigError('publish.json: mode must be "auto" or "manual"');
  const branch = str(r.branch ?? d.branch, "branch", false)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(branch) || branch.includes("..")) throw new PublishConfigError("publish.json: branch is not a safe branch name");
  const ca = (r.commit_author ?? d.commit_author) as Record<string, unknown>;
  const uc = (r.url_check ?? d.url_check) as Record<string, unknown>;
  const num = (v: unknown, field: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new PublishConfigError(`publish.json: ${field} must be a number in [${min}, ${max}]`);
    return v;
  };
  const allow = r.allow_emails ?? d.allow_emails;
  if (!Array.isArray(allow) || allow.some((e) => typeof e !== "string")) throw new PublishConfigError("publish.json: allow_emails must be an array of strings");
  return {
    production_enabled: r.production_enabled === true,
    remote_url: str(r.remote_url, "remote_url", true),
    test_remote_url: str(r.test_remote_url ?? d.test_remote_url, "test_remote_url", false)!,
    branch,
    mode,
    base_url: httpUrl(str(r.base_url, "base_url", true), "base_url"),
    test_base_url: httpUrl(str(r.test_base_url ?? d.test_base_url, "test_base_url", false), "test_base_url")!,
    commit_author: { name: str(ca?.name, "commit_author.name", false)!, email: str(ca?.email, "commit_author.email", false)! },
    url_check: { timeout_s: num(uc?.timeout_s, "url_check.timeout_s", 0, 3600), interval_s: num(uc?.interval_s, "url_check.interval_s", 1, 600) },
    allow_emails: allow as string[],
  };
}

export function loadPublishConfig(file = PUBLISH_CONFIG_PATH): PublishConfig {
  if (!fs.existsSync(file)) return { ...DEFAULT_PUBLISH_CONFIG };
  return parsePublishConfig(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
}

/** Where pushes go, decided by the gate. */
export interface PublishTarget {
  kind: "test" | "production";
  /** The URL / path as configured (relative test paths resolved against repoRoot). Compared to `git remote get-url`. */
  url: string;
  /** For kind "test": the absolute path of the local bare repository. */
  barePath: string | null;
  /** Base URL used for sitemap.xml (production: base_url; test: test_base_url). */
  baseUrl: string | null;
  /** Extra git `-c` options for every command on publish/ (protocol guard when the gate is closed). */
  gitGuard: string[];
}

export class GateClosedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GateClosedError";
  }
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SCP_RE = /^[^/\\]+@[^/\\:]+:/;

/** True for a URL that git would treat as a network remote (scheme other than file://, or scp-like user@host:path). */
export function isNetworkUrl(u: string): boolean {
  if (SCHEME_RE.test(u)) return !/^file:\/\//i.test(u);
  if (SCP_RE.test(u)) return true;
  // host:path (scp short form) — but not a Windows drive letter "C:\..." / "C:/..."
  if (/^[^/\\]{2,}:/.test(u) && !/^[A-Za-z]:[\\/]/.test(u)) return true;
  return false;
}

/** Normalize a local-path remote for comparison (absolute, forward slashes, lower-case drive, no trailing slash). */
export function normalizeLocalPath(p: string, base = paths.root): string {
  let s = p.replace(/^file:\/\/\/?/i, "");
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  s = path.resolve(base, s).replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1);
  return s;
}

export const PROTOCOL_GUARD = ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always"];

/**
 * Decide the push target from the gate. Throws GateClosedError when the gate is closed and the configured test
 * remote is not a local path (or is the harness repository), or when the gate is open without remote_url.
 * (Bare-ness of the test path is checked by the git layer: it needs git.)
 */
export function resolveTarget(cfg: PublishConfig, repoRoot = paths.root): PublishTarget {
  if (cfg.production_enabled) {
    if (!cfg.remote_url) throw new GateClosedError("production_enabled is true but remote_url is not set (harness/config/publish.json)");
    return { kind: "production", url: cfg.remote_url, barePath: null, baseUrl: cfg.base_url, gitGuard: [] };
  }
  const u = cfg.test_remote_url;
  if (isNetworkUrl(u))
    throw new GateClosedError(`the production gate is closed (production_enabled: false): refusing non-local remote "${u}". Until the owner instructs the site opening (U-05), only a local bare repository may be a push target.`);
  const abs = normalizeLocalPath(u, repoRoot);
  const root = normalizeLocalPath(repoRoot, repoRoot);
  if (abs === root || abs.startsWith(root + "/.git") || root.startsWith(abs + "/"))
    throw new GateClosedError(`test_remote_url "${u}" points at the harness repository (or an ancestor); refusing`);
  return { kind: "test", url: abs, barePath: abs, baseUrl: cfg.test_base_url, gitGuard: PROTOCOL_GUARD };
}
