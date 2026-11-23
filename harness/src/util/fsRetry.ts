/**
 * rename with retry (AMENDMENT 13). On Windows a rename over (or of) a file that another process has open — e.g. the
 * Discord runner's `sfsh status` reading logs/jobs/<id>.state.json or a queue file while the worker replaces it —
 * fails transiently with EPERM / EACCES / EBUSY. With parallel jobs and concurrent status calls this happens in
 * practice (A13 measurement: a job failed on `rename … .state.json.<pid>.tmp → .state.json` EPERM). Readers hold the
 * file for milliseconds, so a short retry loop (up to ~2 s) makes the write succeed; other errors are thrown at once.
 */
import fs from "node:fs";

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const sab = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(sab, 0, 0, ms);
}

/** Counter of retried renames in this process (measurement). */
export const renameRetryStats = { retried: 0, maxAttempts: 0 };

export function renameSyncRetry(from: string, to: string, attempts = 80): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      if (i > 1) {
        renameRetryStats.retried++;
        renameRetryStats.maxAttempts = Math.max(renameRetryStats.maxAttempts, i);
      }
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts || !RETRY_CODES.has(code)) throw e;
      sleepSync(Math.min(5 * i, 50));
    }
  }
}
