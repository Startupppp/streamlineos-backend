/**
 * PRD-C144 / PRD-C087 — the Home fanout is CONCURRENT, BOUNDED and INDEPENDENT.
 *
 * Reading `Promise.all` proves none of the three, so nothing here reads the
 * implementation. Concurrency is proved by a barrier that only opens once every
 * section has started: a sequential implementation deadlocks on it. Boundedness
 * is proved by counting the sections actually started while the tenant's module
 * count is varied. Independence is proved by hanging one source forever and
 * requiring the aggregate to answer anyway.
 *
 * The measurement that set HOME_SECTION_DEADLINE_MS is recorded on the constant.
 */

import { Logger } from "@nestjs/common";
import type { AccessService } from "../access/access.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import type { Db } from "../../db/drizzle.module";
import type { DashboardLeaveService } from "./dashboard-leave.service";
import type { DashboardProjectService } from "./dashboard-project.service";
import type { NotificationsService } from "../notifications/notifications.service";
import { DashboardPersonalService } from "./dashboard-personal.service";
import { DashboardStatsService } from "./dashboard-stats.service";
import {
  DASHBOARD_HOME_SECTIONS,
  isModuleSection,
} from "./dashboard-section-registry";
import { HOME_SECTION_DEADLINE_MS, settleSection } from "./dashboard-section-settle";

const ORG = "org-fanout-1";
const USER = "user-fanout-1";
const NEVER = new Promise<never>(() => undefined);

function makeUser(): CurrentUserContext {
  return { userId: USER, orgId: ORG } as CurrentUserContext;
}

function silentLogger(): Logger {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;
}

/**
 * Opens only once `width` distinct sections have reported in. Every section
 * awaits it before producing a value, so the aggregate can only complete if all
 * `width` sections were in flight at the same moment.
 */
function makeBarrier(width: number, timeoutMs: number) {
  const arrived = new Set<string>();
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const guard = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `fanout is not concurrent: only ${arrived.size}/${width} sections started within ${timeoutMs}ms (${[...arrived].join(", ")})`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });

  return {
    arrived,
    async wait(name: string): Promise<void> {
      arrived.add(name);
      if (arrived.size >= width) open();
      await Promise.race([gate, guard]);
    },
  };
}

function personalAccess(availableModules: readonly string[]): AccessService {
  return {
    moduleAvailability: jest
      .fn()
      .mockImplementation((_u: CurrentUserContext, mod: string) =>
        Promise.resolve({ available: availableModules.includes(mod) }),
      ),
  } as unknown as AccessService;
}

/**
 * Every source of getPersonalDashboard routed through `hook`, which decides what
 * that source does. The db mock reproduces the real call order: the timesheet
 * select, then the attendee LATERAL, then the outer calendarEvents query, then
 * the EXISTS condition builders.
 */
function makePersonalHarness(hook: (name: string) => Promise<unknown>) {
  const conditionChain: Record<string, unknown> = {
    from: () => conditionChain,
    innerJoin: () => conditionChain,
    where: (cond: unknown) => cond,
  };
  const lateralChain: Record<string, unknown> = {
    from: () => lateralChain,
    where: () => ({
      limit: () => ({
        as: () =>
          new Proxy({} as Record<string, unknown>, {
            get: () => ({ hit: null }),
          }),
      }),
    }),
  };
  const eventsChain: Record<string, unknown> = {
    from: () => eventsChain,
    leftJoinLateral: () => eventsChain,
    where: () => ({ orderBy: () => ({ limit: () => hook("upcomingEvents") }) }),
  };
  const timesheetChain: Record<string, unknown> = {
    from: () => timesheetChain,
    where: () => hook("timesheet"),
  };

  let selectCall = 0;
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: "member-fanout-1", status: "ACTIVE" }),
      },
    },
    select: jest.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) return timesheetChain;
      if (selectCall === 2) return lateralChain;
      if (selectCall === 3) return eventsChain;
      return conditionChain;
    }),
  } as unknown as Db;

  const leave = {
    getMyLeaveBalance: jest.fn().mockImplementation(() => hook("leaveBalance")),
  } as unknown as DashboardLeaveService;
  const project = {
    getMyIssues: jest.fn().mockImplementation(() => hook("myTasks")),
  } as unknown as DashboardProjectService;
  const notifications = {
    unreadCount: jest.fn().mockImplementation(() => hook("unreadNotifications")),
  } as unknown as NotificationsService;

  return { db, leave, project, notifications };
}

const ALL_PERSONAL_MODULES = ["build", "timesheets", "hr"] as const;
const PERSONAL_SECTION_NAMES = [
  "myTasks",
  "timesheet",
  "leaveBalance",
  "upcomingEvents",
  "unreadNotifications",
] as const;

describe("PRD-C144 — Home sections fan out CONCURRENTLY", () => {
  it("MEASURED: every personal-dashboard section is in flight at the same moment", async () => {
    const barrier = makeBarrier(PERSONAL_SECTION_NAMES.length, 4_000);
    const harness = makePersonalHarness(async (name) => {
      await barrier.wait(name);
      return name === "unreadNotifications" ? { count: 0 } : [];
    });

    const svc = new DashboardPersonalService(
      harness.db,
      personalAccess(ALL_PERSONAL_MODULES),
      harness.leave,
      harness.project,
      harness.notifications,
    );

    const result = await svc.getPersonalDashboard(makeUser());

    expect([...barrier.arrived].sort()).toEqual([...PERSONAL_SECTION_NAMES].sort());
    expect(result.degraded).toEqual([]);
  });

  it("BITE: the barrier really does deadlock a sequential fanout", async () => {
    const barrier = makeBarrier(2, 250);
    const sequential = (async () => {
      await barrier.wait("first");
      await barrier.wait("second");
    })();
    await expect(sequential).rejects.toThrow(/fanout is not concurrent: only 1\/2/);
  });
});

describe("PRD-C144 — the Home fanout is BOUNDED", () => {
  it("MEASURED: fanout width does not grow with the tenant's enabled-module count", async () => {
    const widths: number[] = [];
    const moduleCounts: number[] = [];

    for (const extra of [0, 20, 60]) {
      const started = new Set<string>();
      const harness = makePersonalHarness(async (name) => {
        started.add(name);
        return name === "unreadNotifications" ? { count: 0 } : [];
      });
      const enabled = [
        ...ALL_PERSONAL_MODULES,
        ...Array.from({ length: extra }, (_v, i) => `tenant-module-${i}`),
      ];
      const svc = new DashboardPersonalService(
        harness.db,
        personalAccess(enabled),
        harness.leave,
        harness.project,
        harness.notifications,
      );
      await svc.getPersonalDashboard(makeUser());
      widths.push(started.size);
      moduleCounts.push(enabled.length);
    }

    expect(moduleCounts).toEqual([3, 23, 63]);
    expect(widths).toEqual([5, 5, 5]);
  });

  it("MEASURED: module-availability probes are capped by the static registry, not by the tenant", async () => {
    const registryModuleKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter(isModuleSection).map((s) => s.module),
    );
    const access = personalAccess([...ALL_PERSONAL_MODULES, "inventory", "support", "payroll"]);
    const harness = makePersonalHarness(async (name) =>
      name === "unreadNotifications" ? { count: 0 } : [],
    );

    const svc = new DashboardPersonalService(
      harness.db,
      access,
      harness.leave,
      harness.project,
      harness.notifications,
    );
    await svc.getPersonalDashboard(makeUser());

    const probed = (access.moduleAvailability as jest.Mock).mock.calls.map(
      (call: [CurrentUserContext, string]) => call[1],
    );
    expect(new Set(probed)).toEqual(registryModuleKeys);
    expect(probed.length).toBe(registryModuleKeys.size);
  });
});

describe("PRD-C087 — one SLOW source must not delay or fail every section", () => {
  it("MEASURED: settleSection abandons a source that never settles and degrades only it", async () => {
    const degraded: string[] = [];
    const started = Date.now();
    const value = await settleSection({
      name: "unreadNotifications",
      run: () => NEVER,
      fallback: { count: 0 },
      logger: silentLogger(),
      context: `org ${ORG}`,
      onDegraded: (name) => degraded.push(name),
      deadlineMs: 40,
    });
    const elapsed = Date.now() - started;

    expect(value).toEqual({ count: 0 });
    expect(degraded).toEqual(["unreadNotifications"]);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("MEASURED: a fast source is never charged the deadline", async () => {
    const degraded: string[] = [];
    const value = await settleSection({
      name: "announcements",
      run: async () => "answered",
      fallback: "fallback",
      logger: silentLogger(),
      context: `org ${ORG}`,
      onDegraded: (name) => degraded.push(name),
      deadlineMs: 40,
    });
    expect(value).toBe("answered");
    expect(degraded).toEqual([]);
  });

  it("MEASURED: a rejection after the deadline never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await settleSection({
        name: "slow-then-broken",
        run: () =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("late failure")), 30);
            timer.unref?.();
          }),
        fallback: null,
        logger: silentLogger(),
        context: `org ${ORG}`,
        deadlineMs: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("MEASURED: getPersonalDashboard answers with four sections while the fifth hangs forever", async () => {
    const harness = makePersonalHarness(async (name) => {
      if (name === "unreadNotifications") return NEVER;
      if (name === "myTasks")
        return [{ id: 1, title: "Live task", status: "TODO", priority: "HIGH", projectName: "P" }];
      if (name === "timesheet") return [{ hours: "8" }];
      if (name === "leaveBalance")
        return [{ leaveTypeName: "Annual", balance: "5", daysPerYear: 20 }];
      return [];
    });

    const svc = new DashboardPersonalService(
      harness.db,
      personalAccess(ALL_PERSONAL_MODULES),
      harness.leave,
      harness.project,
      harness.notifications,
    );

    const started = Date.now();
    const result = await svc.getPersonalDashboard(makeUser());
    const elapsed = Date.now() - started;

    expect(result.myTasks).toHaveLength(1);
    expect(result.timesheetStatus.hoursLogged).toBe(8);
    expect(result.leaveBalance).toHaveLength(1);
    expect(result.unreadNotifications).toBe(0);
    expect(result.degraded).toEqual(["unreadNotifications"]);
    expect(elapsed).toBeGreaterThanOrEqual(HOME_SECTION_DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(HOME_SECTION_DEADLINE_MS + 2_000);
  }, 20_000);
});

describe("PRD-C087 — DashboardStatsService section independence and parallelism", () => {
  function statsAccess(): AccessService {
    const perms = new Map<string, DataScope>([
      ["hr:employees:view", "all"],
      ["hr:attendance:manage", "all"],
      ["build:tickets:view", "all"],
    ]);
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      scopeFor: jest
        .fn()
        .mockImplementation((_u: CurrentUserContext, key: string) =>
          Promise.resolve(perms.get(key) ?? ("all" as DataScope)),
        ),
      resolveUserPermissions: jest.fn().mockResolvedValue(perms),
    } as unknown as AccessService;
  }

  function passThroughCache(): CacheService {
    return {
      cachedForOrg: jest
        .fn()
        .mockImplementation(
          async (_orgId: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
        ),
    } as unknown as CacheService;
  }

  it("MEASURED: employees and projects do not wait behind the organization lookup", async () => {
    const order: string[] = [];
    let releaseOrg: () => void = () => undefined;
    const orgGate = new Promise<void>((resolve) => {
      releaseOrg = resolve;
    });

    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockImplementation(async () => {
            order.push("org:start");
            await orgGate;
            order.push("org:end");
            return { name: "Fanout Corp", slug: "fc", timezone: "UTC" };
          }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({
          where: async () => {
            order.push("count");
            return [{ cnt: 1 }];
          },
        }),
      })),
    } as unknown as Db;

    const svc = new DashboardStatsService(db, passThroughCache(), statsAccess());
    const pending = svc.getDashboardStats(ORG, makeUser());
    await new Promise((resolve) => setTimeout(resolve, 30));

    const countsBeforeOrgResolved = order.filter((e) => e === "count").length;
    releaseOrg();
    const result = await pending;

    expect(order[0]).toBe("org:start");
    expect(countsBeforeOrgResolved).toBeGreaterThanOrEqual(2);
    expect(order.indexOf("org:end")).toBeGreaterThan(order.indexOf("count"));
    expect(result.totalEmployees).toBe(1);
    expect(result.activeProjects).toBe(1);
  });

  it("MEASURED: a hanging organization lookup still yields the employee and project counts", async () => {
    const db = {
      query: { organizations: { findFirst: jest.fn().mockImplementation(() => NEVER) } },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({ where: async () => [{ cnt: 7 }] }),
      })),
    } as unknown as Db;

    const svc = new DashboardStatsService(db, passThroughCache(), statsAccess());
    const result = await svc.getDashboardStats(ORG, makeUser());

    expect(result.totalEmployees).toBe(7);
    expect(result.activeProjects).toBe(7);
    expect(result.orgName).toBe("Organization");
  }, 20_000);
});
