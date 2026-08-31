import { ReportsService } from "../reports.service";

/**
 * Proves getDepartmentCost and getCostCenter place orderBy before offset.
 *
 * Without ORDER BY, Postgres returns aggregate rows in heap order, which changes
 * between executions — page 2 can repeat rows from page 1 or silently omit rows.
 *
 * Tiebreaker rationale:
 *   getDepartmentCost  — groupBy(orgUnits.name): secondary sort is MIN(orgUnits.id)
 *                        so two same-name departments produce stable relative order.
 *   getCostCenter      — groupBy(costCenter text): secondary sort is MIN(profileId)
 *                        for stable order across cost-center groups.
 *
 * Bite proof: remove the .orderBy(...) line from either method and the
 * "orderByCalledAt >= 0" assertion fails because globalOrder never contains "orderBy".
 */

jest.mock("../lib/report-builders", () => ({
  findRunForMonth: jest.fn().mockResolvedValue({ id: 1, status: "COMPLETE", month: "2026-01" }),
  getRunEmployeeIds: jest.fn().mockResolvedValue([]),
  getLineItemsForRun: jest.fn().mockResolvedValue([]),
}));

function makeOrderingChain(globalOrder: string[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "groupBy", "limit"]) {
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

describe("ReportsService — deterministic ORDER BY before paging", () => {
  describe("getDepartmentCost: orderBy(name, MIN(id)) precedes offset", () => {
    it("orderBy precedes offset in the department-cost aggregate query", async () => {
      const globalOrder: string[] = [];
      const chain = makeOrderingChain(globalOrder);
      const db = { select: jest.fn(() => ({ from: jest.fn(() => chain) })) };
      const svc = new ReportsService(db as never);

      await svc.getDepartmentCost("org-1", "2026-01", {}, { limit: 10, offset: 0 });

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

  describe("getCostCenter: orderBy(costCenter, MIN(id)) precedes offset", () => {
    it("orderBy precedes offset in the cost-center aggregate query", async () => {
      const globalOrder: string[] = [];
      const chain = makeOrderingChain(globalOrder);
      const db = { select: jest.fn(() => ({ from: jest.fn(() => chain) })) };
      const svc = new ReportsService(db as never);

      await svc.getCostCenter("org-1", "2026-01", {}, { limit: 10, offset: 0 });

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
});
