import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  // Filter the original query parts without reserializing retained values/order.
  const parts = url.search.slice(1).split("&").filter((part) => {
    const key = new URLSearchParams(part).keys().next().value?.toLowerCase() ?? "";
    return !key.startsWith("utm_") && !["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"].includes(key);
  });
  url.search = parts.join("&");
  return url.href;
}

export function sourceIdFor(url: string): string {
  return "s" + createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 10);
}

export function httpUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use http(s)");
  if (url.username || url.password) throw new Error("URL credentials are not supported");
  return url;
}

export function isPrivateIp(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(address) !== 6) return false;
  // URL canonicalizes IPv4-mapped IPv6 into hexadecimal words.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (canonical.startsWith("::ffff:")) {
    const words = canonical.slice(7).split(":");
    if (words.length === 2) {
      const n = words.map((word) => parseInt(word, 16));
      return isPrivateIp(`${n[0] >> 8}.${n[0] & 255}.${n[1] >> 8}.${n[1] & 255}`);
    }
  }
  return canonical === "::" || canonical === "::1" || /^(fc|fd)/.test(canonical)
    || /^fe[89ab]/.test(canonical);
}

export async function hasPrivateAddress(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("DNS returned no addresses");
  return addresses.some(({ address }) => isPrivateIp(address));
}

export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local}${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
