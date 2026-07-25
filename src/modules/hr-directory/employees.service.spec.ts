process.env.APP_URL ??= "http://localhost:1000";

import { EmployeesService } from "./employees.service";

describe("EmployeesService.getStats — SQL aggregates, no row fetch", () => {
  function buildService() {
    const leaveAgg = [{ total: "5", approved: "3", pending: "1", rejected: "1" }];
    const byType = [
      { leaveTypeId: 7, count: "2" },
      { leaveTypeId: null, count: "3" },
    ];
    const attAgg = [{ daysPresent: "20", totalHours: "160" }];
    const results: unknown[] = [leaveAgg, byType, attAgg];
    let i = 0;

    function whereResult(rows: unknown) {
      return {
        then: (resolve: (value: unknown) => void) => resolve(rows),
        groupBy: () => Promise.resolve(rows),
      };
    }
    function selectChain(rows: unknown) {
      const chain = { from: () => chain, where: () => whereResult(rows) };
      return chain;
    }

    const leaveFindMany = jest.fn();
    const attFindMany = jest.fn();
    const db = {
      select: jest.fn(() => selectChain(results[i++])),
      query: {
        leaveRequests: { findMany: leaveFindMany },
        attendance: { findMany: attFindMany },
      },
    };
    const service = new EmployeesService(db as never, undefined as never);
    return { service, leaveFindMany, attFindMany };
  }

  it("computes stats via aggregate queries without fetching rows into JS", async () => {
    const { service, leaveFindMany, attFindMany } = buildService();
    const result = await service.getStats("org-1", "user-1");

    expect(result.leaves).toEqual({
      total: 5,
      approved: 3,
      pending: 1,
      rejected: 1,
      byType: { "7": 2, unknown: 3 },
    });
    expect(result.attendance).toEqual({
      daysPresent: 20,
      daysAbsent: 0,
      daysLate: 0,
      totalHours: "160.00",
      avgHoursPerDay: "8.00",
    });
    expect(leaveFindMany).not.toHaveBeenCalled();
    expect(attFindMany).not.toHaveBeenCalled();
  });
});
