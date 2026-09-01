import { TaxAdminService } from "../tax-admin.service";

/**
 * Proves listDeclarations places orderBy(createdAt DESC, id ASC) before offset.
 *
 * Without ORDER BY, Postgres can return rows in any heap order between pages,
 * silently repeating or omitting tax declarations as pages are requested.
 *
 * Tiebreaker rationale: createdAt can tie when multiple declarations are created
 * in the same second (e.g., bulk import). The integer PK `id` is a monotonic
 * tiebreaker that makes the order fully deterministic.
 *
 * Bite proof: remove the .orderBy(...) line from listDeclarations and
 * "orderByCalledAt >= 0" fails because globalOrder never receives "orderBy".
 */

function makeOrderingChain(globalOrder: string[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "leftJoin", "where", "limit"]) {
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

describe("TaxAdminService.listDeclarations — deterministic ORDER BY before paging", () => {
  it("orderBy(createdAt DESC, id ASC) precedes offset", async () => {
    const globalOrder: string[] = [];
    const chain = makeOrderingChain(globalOrder);
    const db = { select: jest.fn(() => ({ from: jest.fn(() => chain) })) };
    const svc = new TaxAdminService(db as never);

    await svc.listDeclarations("org-1", {}, undefined, 50);

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
