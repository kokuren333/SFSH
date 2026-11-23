/**
 * Site settings contract (WP-5.4, CP-041; REQUIREMENTS U-10 / U-14). Pure validation shared by the harness (which
 * reads harness/config/site.json and stages site.public.json) and the renderer (which re-validates what it reads).
 *
 *   site_name: null           → the site shows FALLBACK_SITE_NAME ("SFSH", the official name since AMENDMENT 10).
 *   site_name: "<name>"       → replaces the name everywhere (header, <title> suffix, page text).
 *   contact.kind: "issues"    → the public repository's Issues are the takedown window (U-10 default).
 *   contact.url: null         → the window page says the Issues link is posted when the site opens (no dead link).
 *   contact.url: "https://…"  → rendered as a normal link.
 */
export interface SiteSettings {
  site_name: string | null;
  contact: { kind: 'issues'; url: string | null };
}
export const FALLBACK_SITE_NAME = 'SFSH';
export const DEFAULT_SITE_SETTINGS: SiteSettings = { site_name: null, contact: { kind: 'issues', url: null } };
export const SITE_NAME_MAX = 40;

const fail = (msg: string): never => { throw new Error(`Invalid site settings: ${msg}`); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function exactKeys(v: Record<string, unknown>, keys: string[], where: string): void {
  const extra = Object.keys(v).filter(k => !keys.includes(k));
  if (extra.length) fail(`${where} has unknown key(s) ${extra.join(', ')}`);
  for (const k of keys) if (!(k in v)) fail(`${where}.${k} is required`);
}

/** Strict: unknown keys, multi-line or over-long names, markup, email-like text and non-https URLs are rejected. */
export function validateSiteSettings(value: unknown): SiteSettings {
  if (!isObject(value)) fail('must be an object');
  const v = value as Record<string, unknown>;
  exactKeys(v, ['site_name', 'contact'], 'settings');
  const name = v.site_name;
  if (name !== null) {
    if (typeof name !== 'string') fail('site_name must be a string or null');
    const s = name as string;
    if (!s.trim() || s !== s.trim()) fail('site_name must be non-empty without leading/trailing spaces');
    if ([...s].length > SITE_NAME_MAX) fail(`site_name must be at most ${SITE_NAME_MAX} characters`);
    // One line, no control characters, no markup, no email-like text (the pre-push secret scan blocks emails).
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(s)) fail('site_name must be a single line without control characters');
    if (/[<>]/.test(s)) fail('site_name must not contain < or >');
    if (s.includes('@')) fail('site_name must not contain @');
  }
  if (!isObject(v.contact)) fail('contact must be an object');
  const c = v.contact as Record<string, unknown>;
  exactKeys(c, ['kind', 'url'], 'contact');
  if (c.kind !== 'issues') fail('contact.kind must be "issues"');
  const url = c.url;
  if (url !== null) {
    if (typeof url !== 'string') fail('contact.url must be a string or null');
    const s = url as string;
    if (s.length > 200 || /[\s<>"'`\\@?#]/.test(s)) fail('contact.url must be a plain https URL (no spaces, quotes, @, query or fragment)');
    let u: URL | null = null;
    try { u = new URL(s); } catch { fail('contact.url is not a URL'); }
    if (u!.protocol !== 'https:') fail('contact.url must use https');
    if (u!.username || u!.password || u!.search || u!.hash || !u!.hostname) fail('contact.url must not contain credentials, query or fragment');
    if (u!.href !== s) fail(`contact.url must be in canonical form (${u!.href})`);
  }
  return { site_name: name as string | null, contact: { kind: 'issues', url: url as string | null } };
}

export function displayName(settings: SiteSettings): string {
  return settings.site_name ?? FALLBACK_SITE_NAME;
}
