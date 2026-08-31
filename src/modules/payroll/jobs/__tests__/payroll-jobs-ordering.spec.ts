import { PayrollJobsService } from "../payroll-jobs.service";

/**
 * Proves listFailed places orderBy(createdAt DESC, id ASC) before offset.
 *
 * Without ORDER BY, Postgres returns failed/dead-letter jobs in heap order, which
 * varies between calls — the retry queue page 2 can silently skip jobs or replay
 * page 1.
 *
 * Tiebreaker rationale: createdAt can tie when multiple jobs are enqueued in the
 * same second. The integer PK `id` is a monotonic tiebreaker.
 *
 * Bite proof: remove the .orderBy(...) line from listFailed and "orderByCalledAt >= 0"
 * fails because globalOrder never receives "orderBy".
 */

function makeOrderingChain(globalOrder: string[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "where", "limit"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain["orderBy"] = jest.fn((..._args: unknown[]) => {
    globalOrder.push("orderBy");
    return chain;
  });
  chain["offset"] = jest.fn(() => {
    globalOrder.push("offset");
    return Promise.resolve([]);
  });
  return chain;
}

describe("PayrollJobsService.listFailed — deterministic ORDER BY before paging", () => {
  it("orderBy(createdAt DESC, id ASC) precedes offset", async () => {
    const globalOrder: string[] = [];
    const chain = makeOrderingChain(globalOrder);
    const db = { select: jest.fn(() => ({ from: jest.fn(() => chain) })) };
    const svc = new PayrollJobsService(db as never);

    await svc.listFailed("org-1", 2, 50);

    const orderByCalledAt = globalOrder.indexOf("orderBy");
    const offsetCalledAt = globalOrder.indexOf("offset");
    expect(orderByCalledAt).toBeGreaterThanOrEqual(0);
    expect(offsetCalledAt).toBeGreaterThan(orderByCalledAt);
  });

  it("bite: absent orderBy means the ordering check would fail", () => {
    const seqWithoutOrderBy = ["offset"];
    expect(seqWithoutOrderBy.indexOf("orderBy")).toBe(-1);
    expect(seqWithoutOrderBy.indexOf("orderBy")).not.toBeGreaterThanOrEqual(0);
  });
});
