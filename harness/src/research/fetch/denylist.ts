import { readFileSync } from "node:fs";

export interface DenylistConfig {
  domains: { domain: string; reason: string }[];
  patterns: { pattern: string; reason: string }[];
}
export interface Denylist {
  domains: { domain: string; reason: string }[];
  patterns: { regex: RegExp; reason: string }[];
}

export function loadDenylist(injected?: DenylistConfig): Denylist {
  const config: DenylistConfig = injected ?? JSON.parse(readFileSync(
    new URL("../../../config/denylist.json", import.meta.url), "utf8"));
  return {
    domains: config.domains.map(({ domain, reason }) => ({ domain: domain.toLowerCase().replace(/^\.|\.$/g, ""), reason })),
    patterns: config.patterns.map(({ pattern, reason }) => ({ regex: new RegExp(pattern, "i"), reason })),
  };
}

export function isDenied(input: string, denylist: Denylist = loadDenylist()): { denied: boolean; reason?: string } {
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const domain = denylist.domains.find((entry) => host === entry.domain || host.endsWith("." + entry.domain));
  if (domain) return { denied: true, reason: domain.reason };
  // Decoded paths also catch percent-encoded prohibited text-body paths.
  let decoded = url.href;
  try { decoded = decodeURI(url.href); } catch { /* malformed escapes stay literal */ }
  const pattern = denylist.patterns.find(({ regex }) => regex.test(url.href) || regex.test(decoded));
  return pattern ? { denied: true, reason: pattern.reason } : { denied: false };
}
