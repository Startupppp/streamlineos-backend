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
import type { DashboardProjectService } from "./dashboard-project.service";
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

  const project = {
    getMyIssues: jest.fn().mockImplementation(() => hook("myTasks")),
  } as unknown as DashboardProjectService;

  return { db, project };
}

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

const ALL_PERSONAL_MODULES = ["build", "timesheets", "hr"] as const;
/**
 * THREE, not five. `leaveBalance` and `unreadNotifications` were fanned out on
 * every uncached Home load and read by no client — the aggregate's `leaveBalance`
 * and `unreadNotifications` each appeared exactly once in the whole frontend, as
 * type fields — and the unread count was the most expensive query on the surface
 * (14,053 planning buffers against ~1 ms of execution). Both branches are gone.
 * This list is the pin: a re-added dead branch changes the width and the barrier
 * below stops opening.
 */
const PERSONAL_SECTION_NAMES = ["myTasks", "timesheet", "upcomingEvents"] as const;

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
      harness.project,
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
        return [];
      });
      const enabled = [
        ...ALL_PERSONAL_MODULES,
        ...Array.from({ length: extra }, (_v, i) => `tenant-module-${i}`),
      ];
      const svc = new DashboardPersonalService(harness.db, personalAccess(enabled), harness.project);
      await svc.getPersonalDashboard(makeUser());
      widths.push(started.size);
      moduleCounts.push(enabled.length);
    }

    expect(moduleCounts).toEqual([3, 23, 63]);
    expect(widths).toEqual([3, 3, 3]);
  });

  it("MEASURED: module-availability probes are capped by the static registry, not by the tenant", async () => {
    const registryModuleKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter(isModuleSection).map((s) => s.module),
    );
    const access = personalAccess([...ALL_PERSONAL_MODULES, "inventory", "support", "payroll"]);
    const harness = makePersonalHarness(async () => []);

    const svc = new DashboardPersonalService(harness.db, access, harness.project);
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

  it("MEASURED: getPersonalDashboard answers with two sections while the third hangs forever", async () => {
    const harness = makePersonalHarness(async (name) => {
      if (name === "upcomingEvents") return NEVER;
      if (name === "myTasks")
        return [{ id: 1, title: "Live task", status: "TODO", priority: "HIGH", projectName: "P" }];
      if (name === "timesheet") return [{ hours: "8" }];
      return [];
    });

    const svc = new DashboardPersonalService(
      harness.db,
      personalAccess(ALL_PERSONAL_MODULES),
      harness.project,
    );

    const started = Date.now();
    const result = await svc.getPersonalDashboard(makeUser());
    const elapsed = Date.now() - started;

    expect(result.myTasks).toHaveLength(1);
    expect(result.timesheetStatus.hoursLogged).toBe(8);
    expect(result.upcomingEvents).toEqual([]);
    expect(result.degraded).toEqual(["upcomingEvents"]);
    expect(elapsed).toBeGreaterThanOrEqual(HOME_SECTION_DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(HOME_SECTION_DEADLINE_MS + 2_000);
  }, 20_000);
});

describe("PRD-C087 — DashboardStatsService section independence and parallelism", () => {
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

/**
 * PRD-C144 one layer up: the PROLOGUE that gates the whole fanout was outside
 * the deadline.
 *
 * `dashboard-stats.service.ts` awaited `resolveDashboardStatsFlags` bare, and
 * `dashboard-personal.service.ts` awaited `resolvePersonalDashboardModules` and
 * the membership lookup bare. All three do real database I/O
 * (`moduleAvailability` -> `entitlements.getModuleMap` -> `cache.cachedForOrg`
 * -> `runInTenantTransaction`; `scopeFor` -> `resolveUserPermissions` ->
 * `getPermissionsVersion` -> cache -> Postgres), and every section waits behind
 * them — so a stalled entitlements or permissions read hung the endpoint with
 * the deadline already in place one level below.
 *
 * The existing tests above hang the organization lookup and individual sources,
 * never the gate, which is why none of them saw it.
 */
describe("PRD-C144 — the fanout PROLOGUE is deadline-protected and fails closed", () => {
  function hangingModuleAccess(): AccessService {
    return {
      moduleAvailability: jest.fn().mockImplementation(() => NEVER),
    } as unknown as AccessService;
  }

  function hangingScopeAccess(): AccessService {
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      scopeFor: jest.fn().mockImplementation(() => NEVER),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, DataScope>()),
    } as unknown as AccessService;
  }

  it("MEASURED: /dashboard/personal answers when the module gate never resolves", async () => {
    const harness = makePersonalHarness(async () => []);

    const svc = new DashboardPersonalService(
      harness.db,
      hangingModuleAccess(),
      harness.project,
    );

    const result = await svc.getPersonalDashboard(makeUser());

    // Fails CLOSED: an unresolvable gate is not "allowed".
    expect(result.myTasks).toEqual([]);
    expect(result.timesheetStatus.hoursLogged).toBe(0);
    // And the sections the gate governs are reported degraded, so the widgets
    // render "couldn't load" instead of an authoritative empty list.
    expect(result.degraded).toEqual(
      expect.arrayContaining(["modules", "myTasks", "timesheet"]),
    );
  }, 20_000);

  it("MEASURED: /dashboard/personal answers when the membership lookup never resolves", async () => {
    const harness = makePersonalHarness(async () => []);
    const db = {
      ...(harness.db as unknown as Record<string, unknown>),
      query: { organizationMembers: { findFirst: jest.fn().mockImplementation(() => NEVER) } },
    } as unknown as Db;

    const svc = new DashboardPersonalService(
      db,
      personalAccess(ALL_PERSONAL_MODULES),
      harness.project,
    );

    const result = await svc.getPersonalDashboard(makeUser());

    expect(result.degraded).toEqual(expect.arrayContaining(["membership", "timesheet"]));
  }, 20_000);

  it("MEASURED: /dashboard/stats answers when the permission gate never resolves", async () => {
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "Acme", slug: "acme", timezone: "UTC" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({ where: async () => [{ cnt: 5 }] }),
      })),
    } as unknown as Db;

    const svc = new DashboardStatsService(db, passThroughCache(), hangingScopeAccess());
    const result = await svc.getDashboardStats(ORG, makeUser());

    // The org section, which never depended on the gate, still answers.
    expect(result.orgName).toBe("Acme");
    // The gated counts fail closed — null, not another tenant's numbers.
    expect(result.totalEmployees).toBeNull();
    expect(result.activeProjects).toBeNull();
    expect(result.presentToday).toBeNull();
  }, 20_000);

  it("BITE: the same harness with a resolving gate produces the counts, so the assertions above are not vacuous", async () => {
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "Acme", slug: "acme", timezone: "UTC" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: () => ({ where: async () => [{ cnt: 5 }] }),
      })),
    } as unknown as Db;

    const svc = new DashboardStatsService(db, passThroughCache(), statsAccess());
    const result = await svc.getDashboardStats(ORG, makeUser());

    expect(result.totalEmployees).toBe(5);
    expect(result.activeProjects).toBe(5);
  });
});
