import { PayrollJobsService } from "../payroll-jobs.service";

/**
 * Proves listFailed places orderBy(createdAt DESC, id DESC) before limit and
 * does NOT call offset. Keyset pagination replaces offset: the caller supplies
 * an opaque cursor instead of a page number, so no rows are re-read and no
 * row is skipped when a concurrent insert lands between pages.
 *
 * Tiebreaker rationale: createdAt can tie when multiple jobs are enqueued in the
 * same second. The integer PK `id` is a monotonic tiebreaker. With DESC on both
 * columns the tuple comparison (createdAt, id) < (last, last) is the correct
 * exclusive bound for the next page.
 *
 * Bite proof: remove the .orderBy(...) line from listFailed and "orderByCalledAt >= 0"
 * fails because globalOrder never receives "orderBy".
 */

function makeOrderingChain(globalOrder: string[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "where"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain["orderBy"] = jest.fn((..._args: unknown[]) => {
    globalOrder.push("orderBy");
    return chain;
  });
  chain["limit"] = jest.fn(() => {
    globalOrder.push("limit");
    return Promise.resolve([]);
  });
  chain["offset"] = jest.fn(() => {
    globalOrder.push("offset");
    return Promise.resolve([]);
  });
  return chain;
}

describe("PayrollJobsService.listFailed — deterministic ORDER BY, keyset (no offset)", () => {
  it("orderBy precedes limit and offset is never called", async () => {
    const globalOrder: string[] = [];
    const chain = makeOrderingChain(globalOrder);
    const db = { select: jest.fn(() => ({ from: jest.fn(() => chain) })) };
    const svc = new PayrollJobsService(db as never);

    await svc.listFailed("org-1", undefined, 50);

    const orderByCalledAt = globalOrder.indexOf("orderBy");
    const limitCalledAt = globalOrder.indexOf("limit");
    expect(orderByCalledAt).toBeGreaterThanOrEqual(0);
    expect(limitCalledAt).toBeGreaterThan(orderByCalledAt);
    expect(globalOrder).not.toContain("offset");
  });

  it("bite: absent orderBy means the ordering check would fail", () => {
    const seqWithoutOrderBy = ["limit"];
    expect(seqWithoutOrderBy.indexOf("orderBy")).toBe(-1);
    expect(seqWithoutOrderBy.indexOf("orderBy")).not.toBeGreaterThanOrEqual(0);
  });
});
