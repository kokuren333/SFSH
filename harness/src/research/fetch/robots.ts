export const PRODUCT_TOKEN = "SFSH-research";
export interface RobotsRule { allow: boolean; pattern: string }
export interface RobotsPolicy { allowed(urlOrPath: string): boolean }

// RFC 9309 §2.2.2: compare UTF-8 octets, decoding only unreserved ASCII escapes.
function comparable(value: string): string {
  return value.replace(/%[0-9a-f]{2}|[^\x00-\x7f]/giu, (part) => {
    if (part.startsWith("%")) {
      const char = String.fromCharCode(parseInt(part.slice(1), 16));
      return /^[a-z0-9._~-]$/i.test(char) ? char : part.toUpperCase();
    }
    return encodeURIComponent(part);
  });
}

export function parseRobots(text: string, productToken = PRODUCT_TOKEN): RobotsPolicy {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let group: typeof groups[number] | undefined;
  let hasRules = false;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const match = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.split("#", 1)[0]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === "user-agent") {
      if (!group || hasRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === "allow" || key === "disallow")) {
      hasRules = true;
      if (value.startsWith("/")) group.rules.push({ allow: key === "allow", pattern: comparable(value) });
    }
  }
  const named = groups.filter(({ agents }) => agents.includes(productToken.toLowerCase()));
  const selected = named.length ? named : groups.filter(({ agents }) => agents.includes("*"));
  const rules = selected.flatMap(({ rules }) => rules).map((rule) => {
    const end = rule.pattern.endsWith("$");
    const pattern = end ? rule.pattern.slice(0, -1) : rule.pattern;
    const regex = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (end ? "$" : ""));
    const length = (pattern.replace(/\*/g, "").match(/%[0-9A-F]{2}|./g) ?? []).length;
    return { ...rule, regex, length };
  });
  return {
    allowed(urlOrPath) {
      const path = urlOrPath.startsWith("/") ? urlOrPath : (() => {
        const url = new URL(urlOrPath);
        return url.pathname + url.search;
      })();
      if (path === "/robots.txt") return true;
      const target = comparable(path);
      let best: typeof rules[number] | undefined;
      for (const rule of rules) {
        if (rule.regex.test(target) && (!best || rule.length > best.length || (rule.length === best.length && rule.allow))) best = rule;
      }
      return best?.allow ?? true;
    },
  };
}

// §1.3-2: unreachable robots is deliberately conservative.
export function robotsForStatus(status: number, text = ""): RobotsPolicy {
  if (status >= 200 && status < 300) return parseRobots(text);
  return { allowed: () => status >= 400 && status < 500 };
}
