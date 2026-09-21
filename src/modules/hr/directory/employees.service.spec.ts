process.env.APP_URL ??= "http://localhost:1000";

import { EmployeesService } from "./employees.service";
import { EmployeeAnalyticsService } from "./employee-analytics.service";
import * as applyScopeMod from "../../access/apply-scope";
import { ScopedRead } from "../../access/scoped-read";

describe("EmployeeAnalyticsService.getStats — SQL aggregates, no row fetch", () => {
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
        groupBy: () => ({ limit: () => Promise.resolve(rows) }),
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
    const service = new EmployeeAnalyticsService(db as never, undefined as never);
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

describe("EmployeesService.listEmployees — DataScope wiring", () => {
  const ORG = "org-1";
  const USER = "user-1";

  function buildDb() {
    const dataChain = {
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const joinChain: Record<string, jest.Mock> = {
      leftJoin: jest.fn(),
      where: jest.fn().mockReturnValue(dataChain),
    };
    joinChain["leftJoin"].mockReturnValue(joinChain);
    return {
      dataChain,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue(joinChain),
        }),
      }),
    };
  }

  function buildService(db: ReturnType<typeof buildDb>) {
    const cache = {
      cached: jest.fn().mockImplementation(
        async (_key: string, fn: () => Promise<unknown>) => fn(),
      ),
      cachedVersioned: jest.fn().mockImplementation(
        async (_ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
      ),
      invalidateNamespace: jest.fn(),
    };
    const employment = {
      getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    };
    return new EmployeesService(db as never, cache as never, employment as never);
  }

  let applyScopeSpy: jest.SpyInstance;

  beforeEach(() => {
    applyScopeSpy = jest.spyOn(applyScopeMod, "applyScope");
  });

  afterEach(() => {
    applyScopeSpy.mockRestore();
  });

  it("calls applyScope with scope=own and the caller userId", async () => {
    const db = buildDb();
    const svc = buildService(db);
    await svc.listEmployees(ScopedRead.of(ORG, USER, "own"), {});
    expect(applyScopeSpy).toHaveBeenCalledWith(
      "own",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("calls applyScope with scope=all and the caller userId", async () => {
    const db = buildDb();
    const svc = buildService(db);
    await svc.listEmployees(ScopedRead.of(ORG, USER, "all"), {});
    expect(applyScopeSpy).toHaveBeenCalledWith(
      "all",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("returns a bounded cursor envelope without an exact count", async () => {
    const db = buildDb();
    const svc = buildService(db);
    const result = await svc.listEmployees(ScopedRead.of(ORG, USER, "all"), { limit: 5 });
    expect(result).toMatchObject({
      data: [],
      pageInfo: { limit: 5, hasMore: false, nextCursor: null },
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.dataChain.limit).toHaveBeenCalledWith(6);
  });

  it("denies without calling applyScope or the database when scope=none (ScopedRead short-circuits)", async () => {
    const db = buildDb();
    const svc = buildService(db);
    const result = await svc.listEmployees(ScopedRead.of(ORG, USER, "none"), {});
    expect(applyScopeSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: [],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    });
  });

  it("never selects salary in the standard employee-list DTO", async () => {
    const db = buildDb();
    const svc = buildService(db);
    await svc.listEmployees(ScopedRead.of(ORG, USER, "all"), {});

    const selectedFields = db.select.mock.calls[0]?.[0];
    expect(selectedFields).not.toHaveProperty("monthlySalary");
  });
});

describe("EmployeesService.countEmployees — the summary runs under the list's DataScope", () => {
  const ORG = "org-1";
  const USER = "user-1";

  function buildCountDb(rows: unknown[]) {
    const joinChain: Record<string, jest.Mock> = {
      leftJoin: jest.fn(),
      where: jest.fn().mockResolvedValue(rows),
    };
    joinChain["leftJoin"].mockReturnValue(joinChain);
    return {
      joinChain,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue(joinChain),
        }),
      }),
    };
  }

  function buildService(db: ReturnType<typeof buildCountDb>) {
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        async (_ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
      ),
    };
    const employment = { getFactsBatch: jest.fn() };
    return new EmployeesService(db as never, cache as never, employment as never);
  }

  let applyScopeSpy: jest.SpyInstance;

  beforeEach(() => {
    applyScopeSpy = jest.spyOn(applyScopeMod, "applyScope");
  });

  afterEach(() => {
    applyScopeSpy.mockRestore();
  });

  it("applies the caller's own scope to the aggregate exactly as the list does", async () => {
    const db = buildCountDb([{ active: 1, inactive: 0 }]);
    const svc = buildService(db);
    await expect(
      svc.countEmployees(ScopedRead.of(ORG, USER, "own"), {}),
    ).resolves.toEqual({ active: 1, inactive: 0 });
    expect(applyScopeSpy).toHaveBeenCalledWith(
      "own",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("reports zeros without touching the database when the scope is none", async () => {
    const db = buildCountDb([]);
    const svc = buildService(db);
    await expect(
      svc.countEmployees(ScopedRead.of(ORG, USER, "none"), {}),
    ).resolves.toEqual({ active: 0, inactive: 0 });
    expect(applyScopeSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("reports zeros when the aggregate returns no row rather than inventing a count", async () => {
    const db = buildCountDb([]);
    const svc = buildService(db);
    await expect(
      svc.countEmployees(ScopedRead.of(ORG, USER, "all"), {}),
    ).resolves.toEqual({ active: 0, inactive: 0 });
  });
});
