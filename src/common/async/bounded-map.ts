export async function boundedMap<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  run: (item: TItem, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as TItem;
      try {
        results[index] = { status: "fulfilled", value: await run(item, index) };
      } catch (reason: unknown) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
