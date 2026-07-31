import { IncentivesService } from "../incentives.service";

function makeDb(statsRow: { totalRevenue: string; approvedCount: string; pendingCount: string; thisMonth: string }) {
  const where = jest.fn().mockResolvedValue([statsRow]);
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { select };
}

describe("IncentivesService.getIncentiveStats", () => {
  it("returns zero stats when no incentives exist", async () => {
    const db = makeDb({ totalRevenue: "0", approvedCount: "0", pendingCount: "0", thisMonth: "0" });
    const service = new IncentivesService(db as never);

    const result = await service.getIncentiveStats("org-1");

    expect(result.totalRevenue).toBe("0.00");
    expect(result.thisMonth).toBe("0.00");
    expect(result.approved).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.avgPerConversion).toBe("0.00");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("computes avgPerConversion from approved count", async () => {
    const db = makeDb({ totalRevenue: "30000", approvedCount: "3", pendingCount: "1", thisMonth: "10000" });
    const service = new IncentivesService(db as never);

    const result = await service.getIncentiveStats("org-1");

    expect(result.totalRevenue).toBe("30000.00");
    expect(result.approved).toBe(3);
    expect(result.pending).toBe(1);
    expect(result.avgPerConversion).toBe("10000.00");
    expect(result.thisMonth).toBe("10000.00");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("uses a single SELECT query instead of two findMany scans", async () => {
    const db = makeDb({ totalRevenue: "0", approvedCount: "0", pendingCount: "0", thisMonth: "0" });
    const queryFindMany = jest.fn();
    (db as unknown as { query: { incentives: { findMany: jest.Mock } } }).query = {
      incentives: { findMany: queryFindMany },
    };
    const service = new IncentivesService(db as never);

    await service.getIncentiveStats("org-1");

    expect(queryFindMany).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
