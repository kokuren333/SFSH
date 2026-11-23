# V-2 probe: N consecutive schema-conformant JSON outputs from one model via CLI (non-interactive).
# usage: python -I v2_run.py <haiku|luna> <N> <outdir>
import json, subprocess, sys, time, os, hashlib, datetime, tempfile
import jsonschema, shutil
CLAUDE = shutil.which("claude"); CODEX = shutil.which("codex")
here = os.path.dirname(os.path.abspath(__file__))
which, n, outdir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.makedirs(outdir, exist_ok=True)
schema_path = os.path.join(here, "v2_schema.json")
schema = json.load(open(schema_path, encoding="utf-8"))
prompt = open(os.path.join(here, "v2_prompt.txt"), encoding="utf-8").read()
phash = hashlib.sha256(prompt.encode()).hexdigest()[:16]
work = tempfile.mkdtemp(prefix="sfsh_v2_")
status_path = os.path.join(outdir, f"status_{which}.json")
results = []
def call(i):
    t0 = time.time()
    if which == "haiku":
        cmd = [CLAUDE, "-p", "--model", "claude-haiku-5-5", "--output-format", "json",
               "--json-schema", json.dumps(schema), "--tools", "", "--strict-mcp-config"]
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", cwd=work, timeout=240, shell=False)
        raw = p.stdout
        env = json.loads(raw)
        out = env.get("structured_output")
        if out is None:
            out = json.loads(env["result"])
        meta = {"cost_usd": env.get("total_cost_usd"), "usage": env.get("usage", {}).get("output_tokens"),
                "model": list(env.get("modelUsage", {}).keys())}
    else:
        last = os.path.join(work, f"last_{i}.txt")
        cmd = [CODEX, "exec", "-m", "gpt-6-luna", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
               "--ignore-user-config", "--color", "never", "--output-schema", schema_path, "-o", last, "--json", "-"]
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", cwd=work, timeout=240, shell=False)
        raw = open(last, encoding="utf-8").read()
        out = json.loads(raw)
        usage = None
        for line in p.stdout.splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") == "turn.completed":
                usage = ev.get("usage")
        meta = {"usage": usage, "model": ["gpt-6-luna"]}
    return out, raw, time.time() - t0, p.returncode, meta
for i in range(1, n + 1):
    rec = {"i": i, "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "prompt_hash": phash}
    try:
        out, raw, dt, rc, meta = call(i)
        jsonschema.validate(out, schema)
        rec.update(ok=True, rc=rc, sec=round(dt, 1), meta=meta)
        json.dump(out, open(os.path.join(outdir, f"{which}_{i:02d}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception as e:
        rec.update(ok=False, err=repr(e)[:500])
    results.append(rec)
    json.dump({"which": which, "done": i, "of": n, "results": results}, open(status_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(rec, ensure_ascii=False), flush=True)
    if not rec["ok"]:
        break
ok = sum(r["ok"] for r in results)
print(f"SUMMARY {which}: {ok}/{n} consecutive ok", flush=True)
