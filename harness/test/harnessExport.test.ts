/**
 * M6 `sfsh harness-publish`: allow-list globs, the fixed forbidden paths, and the export scan (needles, secrets,
 * e-mails, reviewed allow entries). Pure functions only (no git, no network).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_REL, FORBIDDEN, globToRegExp, scanExport, type HarnessExportConfig } from "../src/publish/harnessExport.ts";

const any = (p: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(p));

test("globs: ** spans directories, * stays in one segment; forbidden paths are root data dirs, not code or fictional fixtures", () => {
  assert.ok(globToRegExp("harness/src/**").test("harness/src/queue/worker.ts"));
  assert.ok(!globToRegExp("harness/config/*.json").test("harness/config/sub/x.json"));
  assert.ok(globToRegExp("**/*.pem").test("a/b/c.pem") && globToRegExp("**/*.pem").test("c.pem"));
  for (const p of ["works/novel-x/nkg/nkg.json", "logs/LEDGER.md", "queue/done/1.json", "_handoff/A.md", "BRIEF.md", "publish/index.html", "harness-publish/README.md", "site/dist/index.html", ".env", "x/.env.local", "k.pem", CONFIG_REL, "works/a/research/raw/p.html"])
    assert.ok(any(p, FORBIDDEN), p);
  for (const p of ["harness/src/works/store.ts", "site/fixtures/works/novel-akari-2020/work.json", "harness/config/harness-export.example.json", "design/REQUIREMENTS.md"]) assert.ok(!any(p, FORBIDDEN), p);
});

const cfg = (allow: HarnessExportConfig["allow_hits"] = []): HarnessExportConfig => ({
  remote_url: "https://github.com/o/r.git", branch: "main", clone_dir: "harness-publish", commit_author: { name: "o", email: "1+o@users.noreply.github.com" },
  license: "Apache-2.0", include: [], exclude: [], add: {}, replace_all: [], file_rewrites: [],
  private_needles: ["山田太郎", "yamada"], allow_emails: [], allow_hits: allow,
});
const file = (path: string, text: string) => ({ path, data: Buffer.from(text, "utf8") });

test("scan: needles, local paths, tokens and personal e-mails block; noreply / .invalid / example addresses do not", () => {
  const tok = "gh" + "p_" + "a".repeat(36);
  const r = scanExport(cfg(), [
    file("design/a.md", "発注者: 山田太郎"),
    file("harness/src/b.ts", `const p = "C:\\Users\\Yamada\\x";`),
    file("harness/src/c.ts", `const t = "${tok}";`),
    file("harness/src/d.ts", "mail someone.real@gmail.com"),
    file("harness/src/e.ts", "x@users.noreply.github.com sfsh@users.noreply.invalid a@example.com git@github.com"),
    file("logs/LEDGER.md", "x"),
  ]);
  assert.equal(r.ok, false);
  const kinds = r.findings.map((f) => `${f.kind}@${f.path}`);
  for (const k of ["private_needle@design/a.md", "private_needle@harness/src/b.ts", "local_path_windows@harness/src/b.ts", "github_token@harness/src/c.ts", "email@harness/src/d.ts", "forbidden_path@logs/LEDGER.md"]) assert.ok(kinds.includes(k), `${k} in ${kinds.join(", ")}`);
  assert.ok(!kinds.some((k) => k.endsWith("@harness/src/e.ts")), kinds.join(", "));
  const needle = r.findings.find((f) => f.kind === "private_needle")!;
  assert.doesNotMatch(needle.value, /山田/, "the needle itself is never echoed into records");
});

test("scan: exact allow entries (path + kind + value) clear reviewed fixtures; needles and forbidden paths cannot be allowed", () => {
  const files = [file("harness/test/x.test.ts", 'const p = "C:\\tmp\\site.git";'), file("harness/test/y.test.ts", "yamada")];
  const first = scanExport(cfg(), files);
  const lp = first.findings.filter((f) => f.kind === "local_path_windows");
  assert.ok(lp.length >= 1);
  const allow = [...lp.map((f) => ({ path: f.path, kind: f.kind, value: f.value, why: "fixture" })), { path: "harness/test/y.test.ts", kind: "private_needle", value: "needle #2", why: "try" }];
  const second = scanExport(cfg(allow), files);
  assert.deepEqual(second.findings.map((f) => f.kind), ["private_needle"]);
  assert.equal(second.allowed.length, lp.length);
  // the same value in another file is not covered
  const third = scanExport(cfg(allow), [file("harness/src/z.ts", 'const p = "C:\\tmp\\site.git";')]);
  assert.equal(third.ok, false);
});
