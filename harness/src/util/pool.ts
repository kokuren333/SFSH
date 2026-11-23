/** Run `fn` over `xs` with at most `limit` calls in flight; results keep the input order. */
export async function pool<T, R>(xs: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker));
  return out;
}
