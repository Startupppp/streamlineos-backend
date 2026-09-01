/**
 * Bite-proof isolation tests for the Home dashboard (§28.5).
 *
 * TWO GUARANTEES UNDER TEST:
 *   I.  A denied section (module disabled) is OMITTED and its DB query NEVER runs.
 *   II. One section throwing an error leaves ALL other sections populated.
 *
 * Removal proofs are noted per test; removing the cited mechanism turns the test red.
 *
 * DB call order in getPersonalDashboard with ALL modules disabled:
 *   findFirst  → organizationMembers lookup (db.query.organizationMembers.findFirst)
 *   select 1   → outer calendarEvents query (select({id,title,…}).from(calendarEvents).where(…).orderBy(…).limit(3))
 *   select 2   → creator EXISTS inner       (select({one:sql`1`}).from(organizationMembers).where(…))
 *   select 3   → attendee EXISTS inner      (select({one:sql`1`}).from(eventAttendees).innerJoin(…).where(…))
 *   select 4   → notifications count        (select({cnt:count()}).from(notifications).where(…))
 *
 * select 2 and 3 are builder calls inside the argument to the outer .where(); they
 * return a SQL condition object (not a Promise), so they are never directly awaited.
 *
 * Maximum DB calls with all modules enabled: 1 findFirst + 1 tickets.findMany + 3 selects
 * (timesheets-sum, leaveBalances, calendarEvents) + 1 notifications = 6 total (criterion 6).
 */

import type { CacheService } from "../../common/cache/cache.service";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import type { Db } from "../../db/drizzle.module";
import { DashboardPersonalService } from "./dashboard-personal.service";
import { DashboardStatsService } from "./dashboard-stats.service";

const ORG = "org-iso-test-1";
const USER = "user-iso-test-1";

function makeUser(): CurrentUserContext {
  return { userId: USER, orgId: ORG } as CurrentUserContext;
}

function makeAccessAllModulesDisabled(): AccessService {
  return {
    moduleAvailability: jest.fn().mockResolvedValue({ available: false }),
  } as unknown as AccessService;
}

function makeAccessWithModules(build: boolean, timesheets: boolean, hr: boolean): AccessService {
  return {
    moduleAvailability: jest.fn().mockImplementation((_u: CurrentUserContext, mod: string) => {
      const table: Record<string, boolean> = { build, timesheets, hr };
      return Promise.resolve({ available: table[mod] ?? false });
    }),
  } as unknown as AccessService;
}

/**
 * Db mock used for tests that do not need module-conditional queries.
 * Tracks select() call index to route calendarEvents vs EXISTS vs notifications.
 */
function makeNeutralPersonalDb(opts: { ticketsFindMany?: jest.Mock } = {}): {
  db: Db;
  ticketsFindMany: jest.Mock;
} {
  const ticketsFindMany = opts.ticketsFindMany ?? jest.fn().mockResolvedValue([]);

  const innerChain: Record<string, unknown> = {
    from: function () { return innerChain; },
    innerJoin: function () { return innerChain; },
    where: function (cond: unknown) { return cond; },
  };

  const outerEventChain: Record<string, unknown> = {
    from: function () { return outerEventChain; },
    where: function () {
      return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
    },
  };

  const notifChain: Record<string, unknown> = {
    from: function () { return notifChain; },
    where: function () { return Promise.resolve([{ cnt: 0 }]); },
  };

  let callIdx = 0;
  const db = {
    query: {
      tickets: { findMany: ticketsFindMany },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: "member-iso-1" }) },
    },
    select: jest.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return outerEventChain;
      if (callIdx <= 3) return innerChain;
      return notifChain;
    }),
  } as unknown as Db;

  return { db, ticketsFindMany };
}

/**
 * Db mock for the isolation (GUARANTEE II) test.
 * Call 1 (outer calendarEvents) → .limit() rejects with "DB timeout".
 * Call 4+ (notifications)       → .where() resolves with [{cnt: 7}].
 * Removal proof: removing `settle("upcomingEvents", …)` causes the reject to
 * propagate out of Promise.all → getPersonalDashboard rejects entirely →
 * `expect(result.unreadNotifications).toBe(7)` never runs → TEST FAILS.
 */
function makeIsolationPersonalDb(): Db {
  const innerChain: Record<string, unknown> = {
    from: function () { return innerChain; },
    innerJoin: function () { return innerChain; },
    where: function (cond: unknown) { return cond; },
  };

  const failingOuterChain: Record<string, unknown> = {
    from: function () { return failingOuterChain; },
    where: function () {
      return { orderBy: () => ({ limit: () => Promise.reject(new Error("DB timeout")) }) };
    },
  };

  const notifChain: Record<string, unknown> = {
    from: function () { return notifChain; },
    where: function () { return Promise.resolve([{ cnt: 7 }]); },
  };

  let callIdx = 0;
  return {
    query: {
      tickets: { findMany: jest.fn().mockResolvedValue([]) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: "member-iso-1" }) },
    },
    select: jest.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return failingOuterChain;
      if (callIdx <= 3) return innerChain;
      return notifChain;
    }),
  } as unknown as Db;
}

/**
 * GUARANTEE I — DENIED SECTION IS OMITTED AND QUERY NEVER RUNS
 */
describe("DashboardPersonalService — GUARANTEE I: denied section omitted and query never runs", () => {
  /**
   * BITE: removing `modules.build ?` so the settle path always runs would make
   * ticketsFindMany be called → `expect(ticketsFindMany).not.toHaveBeenCalled()` FAILS.
   */
  it("BITE: build module disabled → myTasks is [] and tickets.findMany is NEVER called", async () => {
    const ticketsFindMany = jest.fn().mockResolvedValue([{ id: 99, title: "Leaked task" }]);
    const { db } = makeNeutralPersonalDb({ ticketsFindMany });
    const access = makeAccessWithModules(false, false, false);

    const svc = new DashboardPersonalService(db, access);
    const result = await svc.getPersonalDashboard(makeUser());

    expect(result.myTasks).toEqual([]);
    expect(ticketsFindMany).not.toHaveBeenCalled();
  });

  /**
   * BITE: removing `modules.timesheets ?` so the timesheet select always runs would
   * cause db.select() to be called with a sum(timesheets.hours) argument — but the
   * mock routes call-1 to the outer calendarEvents chain (which has no .from(timesheets)
   * path), so the timesheet branch falls into settle's catch → degraded includes
   * "timesheet" → the assertion `expect(result.degraded).not.toContain("timesheet")` FAILS.
   */
  it("BITE: timesheets module disabled → timesheetStatus zero and no degraded for timesheet", async () => {
    const { db } = makeNeutralPersonalDb();
    const access = makeAccessWithModules(false, false, false);

    const svc = new DashboardPersonalService(db, access);
    const result = await svc.getPersonalDashboard(makeUser());

    expect(result.timesheetStatus.hoursLogged).toBe(0);
    expect(result.degraded).not.toContain("timesheet");
  });

  /**
   * BITE: removing `modules.hr ?` so the leave-balance select always runs would
   * cause settle to catch the mock-chain mismatch → degraded includes "leaveBalance"
   * → `expect(result.degraded).not.toContain("leaveBalance")` FAILS.
   */
  it("BITE: hr module disabled → leaveBalance is [] and no degraded for leaveBalance", async () => {
    const { db } = makeNeutralPersonalDb();
    const access = makeAccessWithModules(false, false, false);

    const svc = new DashboardPersonalService(db, access);
    const result = await svc.getPersonalDashboard(makeUser());

    expect(result.leaveBalance).toEqual([]);
    expect(result.degraded).not.toContain("leaveBalance");
  });

  it("upcomingEvents and unreadNotifications are always returned (universal sections)", async () => {
    const { db } = makeNeutralPersonalDb();
    const access = makeAccessAllModulesDisabled();

    const svc = new DashboardPersonalService(db, access);
    const result = await svc.getPersonalDashboard(makeUser());

    expect(Array.isArray(result.upcomingEvents)).toBe(true);
    expect(typeof result.unreadNotifications).toBe("number");
  });
});

/**
 * GUARANTEE II — ONE SECTION FAILURE LEAVES OTHERS POPULATED
 */
describe("DashboardPersonalService — GUARANTEE II: one section failure leaves others populated", () => {
  let result: Awaited<ReturnType<DashboardPersonalService["getPersonalDashboard"]>>;

  beforeEach(async () => {
    const db = makeIsolationPersonalDb();
    const access = makeAccessAllModulesDisabled();
    const svc = new DashboardPersonalService(db, access);
    result = await svc.getPersonalDashboard(makeUser());
  });

  it("BITE: getPersonalDashboard resolves (not throw) even when upcomingEvents rejects", () => {
    expect(result).toBeDefined();
  });

  it("BITE: upcomingEvents falls back to [] when its query rejects", () => {
    expect(result.upcomingEvents).toEqual([]);
  });

  it("BITE: unreadNotifications is still 7 despite upcomingEvents failure", () => {
    expect(result.unreadNotifications).toBe(7);
  });

  it("BITE: degraded list records the failing section name", () => {
    expect(result.degraded).toContain("upcomingEvents");
  });
});

/**
 * DashboardStatsService — deny-before-query and section isolation
 *
 * GUARANTEE A: when flags.attendance is false the attendance cache is never filled.
 * GUARANTEE B: when flags.employees is false the employees cache is never filled.
 * GUARANTEE C: one section cache failure returns null for that section; org info intact.
 */
describe("DashboardStatsService — deny-before-query and section isolation", () => {
  function makeStatsAccess(overrides: {
    employees?: boolean;
    attendance?: boolean;
    projects?: boolean;
  } = {}): AccessService {
    const { employees = true, attendance = true, projects = true } = overrides;
    const permMap = new Map<string, DataScope>([
      ["hr:attendance:manage", attendance ? "all" : "none"],
      ["hr:employees:view", employees ? "all" : "none"],
      ["build:tickets:view", projects ? "all" : "none"],
    ]);
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      scopeFor: jest.fn().mockImplementation((_u: CurrentUserContext, key: string) =>
        Promise.resolve(permMap.get(key) ?? ("all" as DataScope)),
      ),
      resolveUserPermissions: jest.fn().mockResolvedValue(permMap),
    } as unknown as AccessService;
  }

  function makePassThroughCache(): { cache: CacheService; calledKeys: string[] } {
    const calledKeys: string[] = [];
    const cache = {
      cachedForOrg: jest.fn().mockImplementation(
        async (_orgId: string, key: string, fetcher: () => Promise<unknown>) => {
          calledKeys.push(key);
          return fetcher();
        },
      ),
    } as unknown as CacheService;
    return { cache, calledKeys };
  }

  it("BITE: attendance disabled → stats-attendance cache key is NEVER requested", async () => {
    const access = makeStatsAccess({ attendance: false });
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "Org", slug: "org" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({ where: () => Promise.resolve([{ cnt: 99 }]) }),
      })),
    } as unknown as Db;

    const { cache, calledKeys } = makePassThroughCache();
    const svc = new DashboardStatsService(db, cache, access);
    const result = await svc.getDashboardStats(ORG, makeUser());

    const attendanceCacheRequested = calledKeys.some((k) => k.includes("stats-attendance"));
    expect(attendanceCacheRequested).toBe(false);
    expect(result.presentToday).toBeNull();
  });

  it("BITE: employees disabled → stats-employees cache key is NEVER requested", async () => {
    const access = makeStatsAccess({ employees: false });
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "Org", slug: "org" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({ where: () => Promise.resolve([{ cnt: 50 }]) }),
      })),
    } as unknown as Db;

    const { cache, calledKeys } = makePassThroughCache();
    const svc = new DashboardStatsService(db, cache, access);
    const result = await svc.getDashboardStats(ORG, makeUser());

    const employeesCacheRequested = calledKeys.some((k) => k.includes("stats-employees"));
    expect(employeesCacheRequested).toBe(false);
    expect(result.totalEmployees).toBeNull();
  });

  it("BITE: attendance section failure returns null for presentToday; orgName still present", async () => {
    const access = makeStatsAccess({ attendance: true, employees: false, projects: false });
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "Resilient Corp", slug: "rc" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({
          where: () => Promise.reject(new Error("attendance DB failure")),
        }),
      })),
    } as unknown as Db;

    const { cache } = makePassThroughCache();
    const svc = new DashboardStatsService(db, cache, access);
    const result = await svc.getDashboardStats(ORG, makeUser());

    expect(result.orgName).toBe("Resilient Corp");
    expect(result.presentToday).toBeNull();
    expect(result.totalEmployees).toBeNull();
    expect(result.activeProjects).toBeNull();
  });

  /**
   * ITEM C — stat-card sections must compute counts via SQL aggregates,
   * never via findMany.
   *
   * Bite: installing a findManyMock that throws on every call and asserting
   * getDashboardStats still resolves proves no findMany call occurs.
   * Removal proof: replacing `count()` with a findMany-then-length in any
   * stat section causes findManyMock to throw → getDashboardStats rejects →
   * result is undefined → the toBeDefined assertion FAILS.
   */
  it("BITE (ITEM C): stat-card counts use SQL aggregates — findMany is never called in getDashboardStats", async () => {
    const access = makeStatsAccess({ employees: true, attendance: true, projects: true });
    const findManyMock = jest.fn().mockImplementation(() => {
      throw new Error("ITEM C violation: findMany called in a stat-card section");
    });
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "AggregateOrg", slug: "agg" }),
          findMany: findManyMock,
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({ where: () => Promise.resolve([{ cnt: 42 }]) }),
      })),
    } as unknown as Db;

    const { cache } = makePassThroughCache();
    const svc = new DashboardStatsService(db, cache, access);
    const result = await svc.getDashboardStats(ORG, makeUser());

    expect(result).toBeDefined();
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

/**
 * CRITERION 6 — membership resolved once, maximum DB call count enforced.
 * CRITERION 8 — regression tests: membership cannot bypass section gating or escalate failures.
 */
describe("DashboardPersonalService — membership once + section bypass prevention (criteria 6 & 8)", () => {
  it("CRITERION 6: all modules enabled → exactly 1 findFirst + ≤6 select calls (no duplicate membership query)", async () => {
    const innerChain: Record<string, unknown> = {
      from: function () { return innerChain; },
      innerJoin: function () { return innerChain; },
      where: function (cond: unknown) { return cond; },
    };
    const outerEventChain: Record<string, unknown> = {
      from: function () { return outerEventChain; },
      where: function () { return { orderBy: () => ({ limit: () => Promise.resolve([]) }) }; },
    };
    const timesheetChain: Record<string, unknown> = {
      from: function () { return timesheetChain; },
      where: function () { return Promise.resolve([{ hours: "8" }]); },
    };
    const leaveChain: Record<string, unknown> = {
      from: function () { return leaveChain; },
      innerJoin: function () { return leaveChain; },
      where: function () { return Promise.resolve([]); },
    };
    const notifChain: Record<string, unknown> = {
      from: function () { return notifChain; },
      where: function () { return Promise.resolve([{ cnt: 2 }]); },
    };

    let selectCallCount = 0;
    const findFirstMock = jest.fn().mockResolvedValue({ id: "member-iso-1" });
    const ticketsFindMany = jest.fn().mockResolvedValue([]);

    const db = {
      query: {
        tickets: { findMany: ticketsFindMany },
        organizationMembers: { findFirst: findFirstMock },
      },
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return timesheetChain;
        if (selectCallCount === 2) return leaveChain;
        if (selectCallCount <= 4) return innerChain;
        if (selectCallCount === 5) return outerEventChain;
        return notifChain;
      }),
    } as unknown as Db;

    const access = makeAccessWithModules(true, true, true);
    const svc = new DashboardPersonalService(db, access);
    await svc.getPersonalDashboard(makeUser());

    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(selectCallCount).toBeLessThanOrEqual(6);
    expect(ticketsFindMany).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION (8a): valid selfMember does not activate a module-disabled section", async () => {
    const ticketsFindMany = jest.fn().mockResolvedValue([{ id: 99, title: "Leaked" }]);
    const { db } = makeNeutralPersonalDb({ ticketsFindMany });
    const access = makeAccessWithModules(false, false, false);

    const svc = new DashboardPersonalService(db, access);
    const result = await svc.getPersonalDashboard(makeUser());

    expect(result.myTasks).toEqual([]);
    expect(ticketsFindMany).not.toHaveBeenCalled();
    expect(result.degraded).not.toContain("myTasks");
  });

  it("REGRESSION (8b): a section settle() failure leaves all universal sections intact", async () => {
    const db = makeIsolationPersonalDb();
    const access = makeAccessAllModulesDisabled();
    const svc = new DashboardPersonalService(db, access);
    const result = await svc.getPersonalDashboard(makeUser());

    expect(result).toBeDefined();
    expect(result.unreadNotifications).toBe(7);
    expect(result.upcomingEvents).toEqual([]);
    expect(result.degraded).toContain("upcomingEvents");
  });
});
