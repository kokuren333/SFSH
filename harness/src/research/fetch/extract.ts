import htmlEntities from "./html-entities.json" with { type: "json" };

export interface ExtractedPage { title: string; publisher: string; text: string }
interface Element { tag: string; attrs: Record<string, string>; children: (Element | string)[] }

// Named-character data: https://html.spec.whatwg.org/entities.json (WHATWG HTML).
const ENTITIES: Record<string, string> = htmlEntities;

export function decodeEntities(text: string, inAttribute = false): string {
  return text.replace(/&(?:#x[\da-f]+;?|#\d+;?|[a-z][a-z\d]{0,31};?)/gi, (whole: string, offset: number) => {
    if (!whole.startsWith("&#")) {
      // Longest named reference; legacy semicolon omissions have attribute restrictions.
      for (let length = whole.length; length > 1; length--) {
        const name = whole.slice(0, length);
        if (ENTITIES[name] === undefined) continue;
        if (inAttribute && !name.endsWith(";") && /[=a-z\d]/i.test(text[offset + length] ?? "")) return whole;
        return ENTITIES[name] + whole.slice(length);
      }
      return whole;
    }
    const hex = whole[2].toLowerCase() === "x";
    const code = parseInt(whole.slice(hex ? 3 : 2), hex ? 16 : 10);
    if (code >= 0x80 && code <= 0x9f) return new TextDecoder("windows-1252").decode(new Uint8Array([code]));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = tag.replace(/^<\s*[^\s/>]+/, "").replace(/\/?>$/, "");
  for (const match of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[match[1].toLowerCase()] ??= decodeEntities(match[2] ?? match[3] ?? match[4] ?? "", true);
  }
  return attrs;
}

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const REMOVE = new Set("script style noscript svg nav header footer aside form iframe template".split(" "));
const BLOCK = new Set("address article blockquote br caption dd details div dl dt fieldset figcaption figure h1 h2 h3 h4 h5 h6 hr li main ol p pre section summary table tbody td th thead tr ul".split(" "));

// A bounded, non-executing tokenizer/tree, including quoted '>' and raw-text elements.
function parseHtml(html: string): Element {
  const root: Element = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</gi;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const token = match[0];
    if (token.startsWith("<!")) continue;
    const tag = /^<\s*(\/?)\s*([a-z][\w:-]*)/i.exec(token);
    if (!tag) { stack.at(-1)!.children.push(token); continue; }
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      const index = stack.findLastIndex((element) => element.tag === name);
      if (index > 0) stack.length = index;
      continue;
    }
    // Common omitted end tags; malformed input must not swallow the rest of the page.
    if (["li", "p", "dt", "dd", "tr", "td", "th"].includes(name) && stack.at(-1)!.tag === name) stack.pop();
    const element: Element = { tag: name, attrs: attributes(token), children: [] };
    stack.at(-1)!.children.push(element);
    if (["script", "style", "title", "textarea"].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, "gi");
      close.lastIndex = tokens.lastIndex;
      const ending = close.exec(html);
      element.children.push(html.slice(tokens.lastIndex, ending?.index ?? html.length));
      tokens.lastIndex = ending ? close.lastIndex : html.length;
    } else if (!VOID.has(name) && !token.endsWith("/>")) {
      stack.push(element);
    }
  }
  return root;
}

function find(root: Element, predicate: (node: Element) => boolean): Element | undefined {
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (predicate(node)) return node;
    if (!REMOVE.has(node.tag)) {
      for (const child of node.children) if (typeof child !== "string") queue.push(child);
    }
  }
  return undefined;
}

function textOf(root: Element): string {
  const pieces: string[] = [];
  const stack: (Element | string)[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === "string") { pieces.push(decodeEntities(node)); continue; }
    if (REMOVE.has(node.tag) || node.tag === "head" || node.tag === "title") continue;
    const block = BLOCK.has(node.tag);
    if (block) pieces.push("\n");
    if (block) stack.push("\n");
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return pieces.join("").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractMainText(html: string, url: string): ExtractedPage {
  const root = parseHtml(html);
  const titleNode = find(root, (node) => node.tag === "title");
  const title = decodeEntities(titleNode?.children.filter((child) => typeof child === "string").join("") ?? "").replace(/\s+/g, " ").trim();
  const publisher = find(root, (node) => node.tag === "meta" && (node.attrs.property ?? node.attrs.name)?.toLowerCase() === "og:site_name")?.attrs.content;
  const main = find(root, (node) => node.attrs.id === "mw-content-text")
    ?? find(root, (node) => node.tag === "main") ?? find(root, (node) => node.tag === "article")
    ?? find(root, (node) => node.tag === "body") ?? root;
  // §1.3: local evidence text is bounded; verification excerpts are filled later.
  return { title, publisher: publisher?.trim() || new URL(url).hostname, text: textOf(main).slice(0, 60_000) };
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  let sniffed: string | undefined;
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
      const attrs = attributes(tag);
      sniffed = attrs.charset ?? (attrs["http-equiv"]?.toLowerCase() === "content-type"
        ? /charset\s*=\s*([^\s;"']+)/i.exec(attrs.content ?? "")?.[1] : undefined);
      if (sniffed) break;
    }
  }
  return new TextDecoder(charset ?? sniffed ?? "utf-8").decode(bytes);
}
