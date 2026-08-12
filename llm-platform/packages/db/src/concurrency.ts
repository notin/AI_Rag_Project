/**
 * Run an async mapper over items with a bounded number in flight at once.
 * Results are returned in the original input order.
 *
 * Used for both embedding batches (ingest) and extraction calls (graph) — the
 * cap is what keeps a burst of work from tripping provider rate limits.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) break;
        results[current] = await fn(items[current]!, current);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
