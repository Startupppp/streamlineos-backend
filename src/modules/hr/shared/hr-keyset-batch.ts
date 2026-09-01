/**
 * Read a complete tenant-scoped set in bounded keyset batches.
 *
 * The callback owns the tenant, lifecycle and soft-delete predicates.  The
 * helper only supplies the strictly-after id boundary and stops on a short
 * batch, so it cannot silently discard rows at an arbitrary cap.
 */
export async function readHrKeysetBatches<T>(
  read: (afterId: number | undefined, batchSize: number) => Promise<T[]>,
  idOf: (row: T) => number,
  batchSize = 250,
): Promise<T[]> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("HR keyset batch size must be a positive integer");
  }

  const all: T[] = [];
  let afterId: number | undefined;

  for (;;) {
    const batch = await read(afterId, batchSize);
    all.push(...batch);
    if (batch.length < batchSize) return all;

    const last = batch[batch.length - 1];
    if (!last) return all;
    const nextId = idOf(last);
    if (!Number.isSafeInteger(nextId) || nextId <= (afterId ?? 0)) {
      throw new Error("HR keyset reader did not advance");
    }
    afterId = nextId;
  }
}
