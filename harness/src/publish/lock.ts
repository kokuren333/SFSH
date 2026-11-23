/** Directory lock (mkdir is atomic). A lock whose owner pid is dead is taken over. Same scheme as the build lock. */
import fs from "node:fs";
import path from "node:path";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withDirLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs = 20 * 60_000): Promise<T> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), token, "utf8");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = "";
      try {
        owner = fs.readFileSync(path.join(lockDir, "owner"), "utf8");
      } catch {
        /* being created or removed */
      }
      const pid = Number(owner.split(":")[0]);
      if (owner && pid && !pidAlive(pid)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`publish lock busy (${lockDir}, owner ${owner || "?"})`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(path.join(lockDir, "owner"), "utf8") === token) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
