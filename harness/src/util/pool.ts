/**
 * Run `fn` over `xs` with at most `limit` calls in flight; results keep the input order.
 *
 * AMENDMENT 14 (idempotency): when a call fails, no new item is started and the first error is thrown only after
 * every call already in flight has settled. A failing stage is retried from its start (runner, 4.4) — with this rule
 * no call of the failed attempt is still running (and still writing / mutating stage state) when the retry begins,
 * so a retry never overlaps or doubles the work of the attempt it replaces.
 */
export async function pool<T, R>(xs: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  let failed = false;
  let firstError: unknown = null;
  const worker = async () => {
    while (!failed && next < xs.length) {
      const i = next++;
      try {
        out[i] = await fn(xs[i]!, i);
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker));
  if (failed) throw firstError;
  return out;
}
