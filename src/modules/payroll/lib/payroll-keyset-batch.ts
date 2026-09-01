/**
 * Reads a complete run-scoped collection in bounded keyset pages.
 * Callers own the tenant and lifecycle predicates; this helper only guarantees
 * that a large result is never silently truncated in memory.
 */
export const PAYROLL_BATCH_SIZE = 500;

export async function readPayrollKeysetBatches<T>(input: {
  fetch: (afterId: number | null, limit: number) => Promise<T[]>;
  idOf: (row: T) => number;
  batchSize?: number;
}): Promise<T[]> {
  const batchSize = input.batchSize ?? PAYROLL_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("Payroll batch size must be a positive integer");
  }

  const result: T[] = [];
  let afterId: number | null = null;
  for (;;) {
    const page = await input.fetch(afterId, batchSize);
    result.push(...page);
    if (page.length < batchSize) return result;

    const nextId = input.idOf(page[page.length - 1]!);
    if (afterId !== null && nextId <= afterId) {
      throw new Error("Payroll keyset batch did not advance");
    }
    afterId = nextId;
  }
}
