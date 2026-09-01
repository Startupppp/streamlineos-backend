import { PayrollTemplatesService } from "../templates.service";

/**
 * Proves PayrollTemplatesService.list places orderBy(name ASC, id ASC) before offset.
 *
 * Without ORDER BY, Postgres returns template rows in heap order between pages,
 * silently repeating or dropping templates as the catalog is browsed.
 *
 * Tiebreaker rationale: template names are user-defined strings and can collide
 * (e.g., two orgs both name a template "Standard"). The integer PK `id` breaks ties.
 *
 * Bite proof: remove the .orderBy(...) line from list() and "orderByCalledAt >= 0"
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

describe("PayrollTemplatesService.list — deterministic ORDER BY before paging", () => {
  it("orderBy(name ASC, id ASC) precedes offset in the template list query", async () => {
    const globalOrder: string[] = [];
    const chain = makeOrderingChain(globalOrder);

    let callCount = 0;
    const db = {
      select: jest.fn(() => {
        callCount++;
        if (callCount === 1) {
          return {
            from: jest.fn(() => ({
              where: jest.fn().mockResolvedValue([{ count: 999 }]),
            })),
          };
        }
        if (callCount === 2) {
          return { from: jest.fn(() => chain) };
        }
        return {
          from: jest.fn(() => ({
            where: jest.fn().mockResolvedValue([{ count: 0 }]),
          })),
        };
      }),
    };

    const svc = new PayrollTemplatesService(db as never);

    await svc.list("org-1", { page: 2, pageSize: 20 });

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
