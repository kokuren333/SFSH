/**
 * A-2(a) image / media contamination in gen/public.json strings (§5.1, PLAN "A-2"). Rules, applied in this
 * order on each string (each match is removed before the next rule runs, so nothing is counted twice):
 *  1. paired HTML media elements with their content: video, audio, picture, iframe, object, foreignObject
 *  2. remaining HTML media tags (opening, self-closing or closing): img, picture, source, video, audio, track,
 *     iframe, embed, object, image, foreignObject
 *  3. Markdown images  ![alt](target)
 *  4. CSS url(…) (url(#fragment) is not media)
 *  5. data:image|audio|video/… URIs
 *  6. embed / player URLs (YouTube, youtu.be, Vimeo player, niconico embed/watch, Spotify / SoundCloud players …)
 *  7. http(s) or protocol-relative URLs whose path ends with a media extension
 * sources[].url is out of scope (links to sources are allowed).
 */
import { sha16 } from "./leaves.ts";
import type { A2Kind } from "./types.ts";

/** Image / audio / video extensions (also used for dist files). */
export const MEDIA_EXTENSIONS = [
  "png", "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "gif", "webp", "avif", "apng", "bmp", "ico", "cur", "tif", "tiff", "heic", "heif", "jxl", "psd", "svgz",
  "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "mid", "midi", "wma", "aif", "aiff", "amr",
  "mp4", "m4v", "webm", "mov", "avi", "mkv", "ogv", "wmv", "flv", "3gp", "3g2", "mpg", "mpeg", "m3u8", "mpd", "swf",
];
/** URL extensions treated as media in strings (adds svg: an external SVG is an image hotlink). */
const URL_MEDIA_EXT = [...MEDIA_EXTENSIONS, "svg"].sort((a, b) => b.length - a.length).join("|");

const URL_CHARS = `[^\\s"'<>()\\[\\]{}「」『』、。，．（）]`;

export const RE = {
  htmlPaired: () => /<(video|audio|picture|iframe|object|foreignObject)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
  htmlTag: () => /<\/?(?:img|picture|source|video|audio|track|iframe|embed|object|image|foreignObject)\b[^>]*>/gi,
  markdownImage: () => /!\[[^\]\n]*\]\([^)\n]*\)/g,
  cssUrl: () => /url\(\s*(?!['"]?\s*#)[^)]*\)/gi,
  dataUri: () => /data:(?:image|audio|video)\/[^\s"'<>)\]]*/gi,
  embedUrl: () =>
    new RegExp(
      `(?:https?:)?//(?:www\\.|m\\.)?(?:youtube(?:-nocookie)?\\.com/(?:embed|v|shorts|watch|live)\\b|youtu\\.be/|player\\.vimeo\\.com/|vimeo\\.com/\\d|(?:embed|ext|live)\\.nicovideo\\.jp/|nicovideo\\.jp/watch/|nico\\.ms/|open\\.spotify\\.com/embed|w\\.soundcloud\\.com/player|player\\.bilibili\\.com/|dailymotion\\.com/embed|platform\\.twitter\\.com/embed|tiktok\\.com/embed)${URL_CHARS}*`,
      "gi",
    ),
  mediaUrl: () => new RegExp(`(?:https?:)?//${URL_CHARS}+?\\.(?:${URL_MEDIA_EXT})(?:[?#]${URL_CHARS}*)?(?![\\w./-])`, "gi"),
};

const RULES: { kind: A2Kind; re: () => RegExp }[] = [
  { kind: "html_media_tag", re: RE.htmlPaired },
  { kind: "html_media_tag", re: RE.htmlTag },
  { kind: "markdown_image", re: RE.markdownImage },
  { kind: "css_url", re: RE.cssUrl },
  { kind: "data_uri", re: RE.dataUri },
  { kind: "embed_url", re: RE.embedUrl },
  { kind: "media_url", re: RE.mediaUrl },
];

export interface A2StringHit {
  kind: A2Kind;
  sha256: string;
}

/** Detect and strip media from one string. `out` = the string with every match removed (trimmed if changed). */
export function stripMedia(value: string): { out: string; hits: A2StringHit[] } {
  let s = value;
  const hits: A2StringHit[] = [];
  for (const r of RULES) {
    const re = r.re();
    if (!re.test(s)) continue;
    s = s.replace(r.re(), (m) => {
      hits.push({ kind: r.kind, sha256: sha16(m) });
      return "";
    });
  }
  return { out: hits.length ? s.trim() : value, hits };
}
