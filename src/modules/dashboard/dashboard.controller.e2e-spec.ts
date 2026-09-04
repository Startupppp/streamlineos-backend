jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { DashboardStatsService } from "src/modules/dashboard/dashboard-stats.service";
import { DashboardAvailabilityService } from "src/modules/dashboard/dashboard-availability.service";
import { DashboardBirthdaysService } from "src/modules/dashboard/dashboard-birthdays.service";
import { DashboardPersonalService } from "src/modules/dashboard/dashboard-personal.service";
import { DashboardLeaveService } from "src/modules/dashboard/dashboard-leave.service";
import { DashboardAnnouncementsService } from "src/modules/dashboard/dashboard-announcements.service";
import { DashboardCrmService } from "src/modules/dashboard/dashboard-crm.service";
import { DashboardProjectService } from "src/modules/dashboard/dashboard-project.service";

type Method = "get" | "post" | "patch" | "delete";

/**
 * PRD-C115 / PRD-C144 — representative E2E for the Home aggregate.
 *
 * This file used to be one `it.each` asserting 401 over eighteen routes and
 * nothing else. 401 is the cheapest tier there is: it is decided by the first
 * guard in the chain and says nothing about the three properties Home actually
 * has to hold — that the universal surface stays reachable for a member with no
 * grants at all, that the gated sections stay gated, and that a section which
 * fails degrades alone instead of taking the page down.
 *
 * The route table below carries each route's real gate, so the tiers are
 * derived from one declaration rather than three hand-kept lists.
 */
interface RouteCase {
  method: Method;
  path: string;
  /** `@RequireModule`, when the route carries one. */
  module?: "hr" | "build" | "crm";
  /** `@RequirePermission`, when the route carries one. */
  permission?: string;
  /** `@Universal()` — reachable with zero grants, per the platform-core rule. */
  universal: boolean;
  successStatus?: number;
}

const ROUTES: readonly RouteCase[] = [
  { method: "get", path: "/dashboard/active-sprint", module: "build", universal: true },
  { method: "get", path: "/dashboard/announcements", universal: true },
  {
    method: "post",
    path: "/dashboard/announcements",
    permission: "settings:manage",
    universal: false,
    successStatus: 201,
  },
  {
    method: "delete",
    path: "/dashboard/announcements?id=1",
    permission: "settings:manage",
    universal: false,
  },
  { method: "get", path: "/dashboard/birthdays", module: "hr", universal: true },
  { method: "get", path: "/dashboard/executive", permission: "hr:analytics:read", universal: false },
  {
    method: "get",
    path: "/dashboard/leaves-today",
    module: "hr",
    permission: "hr:leaves:view",
    universal: false,
  },
  { method: "get", path: "/dashboard/my-issues?userId=u1", module: "build", universal: true },
  { method: "get", path: "/dashboard/my-leave-balance", module: "hr", universal: true },
  {
    method: "get",
    path: "/dashboard/pending-approvals",
    module: "hr",
    permission: "hr:leaves:approve",
    universal: false,
  },
  { method: "get", path: "/dashboard/personal", universal: true },
  {
    method: "get",
    path: "/dashboard/recent-activity",
    module: "build",
    permission: "build:tickets:view",
    universal: false,
  },
  {
    method: "get",
    path: "/dashboard/recent-projects",
    module: "build",
    permission: "build:tickets:view",
    universal: false,
  },
  { method: "get", path: "/dashboard/stats", universal: true },
  {
    method: "get",
    path: "/dashboard/team-attendance",
    module: "hr",
    permission: "hr:attendance:view",
    universal: false,
  },
  {
    method: "get",
    path: "/dashboard/team-availability",
    module: "hr",
    permission: "hr:attendance:view",
    universal: false,
  },
  {
    method: "get",
    path: "/dashboard/today-activities",
    module: "crm",
    permission: "crm:leads:view",
    universal: false,
  },
  { method: "get", path: "/dashboard/upcoming-holidays", module: "hr", universal: true },
];

const CREATE_ANNOUNCEMENT_BODY = {
  title: "All-hands on Friday",
  content: "Please join in the main room at 10:00.",
};

function bodyFor(route: RouteCase): Record<string, unknown> | undefined {
  return route.method === "post" ? CREATE_ANNOUNCEMENT_BODY : undefined;
}

function call(app: INestApplication, route: RouteCase, token?: string): request.Test {
  const agent = request(app.getHttpServer());
  const req =
    route.method === "get"
      ? agent.get(route.path)
      : route.method === "post"
        ? agent.post(route.path)
        : route.method === "delete"
          ? agent.delete(route.path)
          : agent.patch(route.path);
  if (token) req.set("Authorization", `Bearer ${token}`);
  const body = bodyFor(route);
  return body ? req.send(body) : req;
}

describe("Dashboard auth (e2e)", () => {
  let app: INestApplication;

  /*
   * Every aggregate service is stubbed. The tiers under test are decided by the
   * guard chain, and leaving the services real makes each 200 a live query
   * against whatever DATABASE_URL happens to point at — which is how a suite
   * that means to assert authorization ends up asserting connectivity.
   */
  const stats = { getDashboardStats: jest.fn().mockResolvedValue({ orgName: "Acme" }) };
  const availability = {
    getTeamAttendance: jest.fn().mockResolvedValue([]),
    getTeamAvailability: jest.fn().mockResolvedValue([]),
  };
  const birthdays = { getBirthdays: jest.fn().mockResolvedValue([]) };
  const personal = {
    getPersonalDashboard: jest
      .fn()
      .mockResolvedValue({ myTasks: [], timesheetStatus: null, upcomingEvents: [], degraded: [] }),
  };
  const leave = {
    getLeavesToday: jest.fn().mockResolvedValue([]),
    getMyLeaveBalance: jest.fn().mockResolvedValue([]),
    getPendingApprovals: jest.fn().mockResolvedValue([]),
    getUpcomingHolidays: jest.fn().mockResolvedValue([]),
  };
  const announcements = {
    getActiveAnnouncements: jest.fn().mockResolvedValue([]),
    createAnnouncement: jest.fn().mockResolvedValue({ id: 1 }),
    deleteAnnouncement: jest.fn().mockResolvedValue({ success: true }),
  };
  const crm = {
    getExecutiveDashboard: jest.fn().mockResolvedValue({}),
    getTodayActivities: jest.fn().mockResolvedValue([]),
  };
  const project = {
    getActiveSprintSummary: jest.fn().mockResolvedValue(null),
    getMyIssues: jest.fn().mockResolvedValue([]),
    getRecentActivity: jest.fn().mockResolvedValue([]),
    getRecentProjects: jest.fn().mockResolvedValue([]),
  };

  const everyServiceFn = [
    ...Object.values(stats),
    ...Object.values(availability),
    ...Object.values(birthdays),
    ...Object.values(personal),
    ...Object.values(leave),
    ...Object.values(announcements),
    ...Object.values(crm),
    ...Object.values(project),
  ];

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DashboardStatsService, useValue: stats },
        { provide: DashboardAvailabilityService, useValue: availability },
        { provide: DashboardBirthdaysService, useValue: birthdays },
        { provide: DashboardPersonalService, useValue: personal },
        { provide: DashboardLeaveService, useValue: leave },
        { provide: DashboardAnnouncementsService, useValue: announcements },
        { provide: DashboardCrmService, useValue: crm },
        { provide: DashboardProjectService, useValue: project },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    for (const fn of everyServiceFn) fn.mockClear();
  });

  function noHandlerRan(): void {
    for (const fn of everyServiceFn) expect(fn).not.toHaveBeenCalled();
  }

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    "401 on %s %s without a token",
    async (_method, _path, route) => {
      const res = await call(app, route);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
      noHandlerRan();
    },
  );

  const universalRoutes = ROUTES.filter((r) => r.universal);
  const permissionRoutes = ROUTES.filter((r) => r.permission !== undefined);
  const moduleRoutes = ROUTES.filter((r) => r.module !== undefined);

  it("the route table matches the controller — every tier below has a non-empty corpus", () => {
    expect(ROUTES).toHaveLength(18);
    expect(universalRoutes.length).toBeGreaterThanOrEqual(7);
    expect(permissionRoutes.length).toBeGreaterThanOrEqual(10);
    expect(moduleRoutes.length).toBeGreaterThanOrEqual(12);
  });

  it.each(universalRoutes.map((r) => [r.method, r.path, r] as const))(
    "UNIVERSAL: %s %s answers for a member holding ZERO permissions — Home is platform core, not an entitlement",
    async (_method, _path, route) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(app, route, token);
      expect(res.status).toBe(route.successStatus ?? 200);
    },
  );

  it.each(permissionRoutes.map((r) => [r.method, r.path, r] as const))(
    "GATED: %s %s is 403 for a member holding every module but not its permission",
    async (_method, _path, route) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(app, route, token);
      expect(res.status).toBe(403);
      noHandlerRan();
    },
  );

  it.each(permissionRoutes.map((r) => [r.method, r.path, r] as const))(
    "GATED: %s %s answers once its own permission is held",
    async (_method, _path, route) => {
      const token = await signToken({
        permissions: [route.permission as string],
        enabledModules: ALL_MODULES,
      });
      const res = await call(app, route, token);
      expect(res.status).toBe(route.successStatus ?? 200);
    },
  );

  it.each(moduleRoutes.map((r) => [r.method, r.path, r] as const))(
    "MODULE: %s %s is 402 when its module is not enabled, even holding its permission",
    async (_method, _path, route) => {
      const token = await signToken({
        permissions: route.permission ? [route.permission] : [],
        enabledModules: ALL_MODULES.filter((m) => m !== route.module),
      });
      const res = await call(app, route, token);
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED" });
      noHandlerRan();
    },
  );

  it("CROSS-TENANT: the org every section reads comes from the token, never the request", async () => {
    const token = await signToken({
      orgId: "org_alien",
      sub: "user_alien",
      permissions: ["hr:analytics:read"],
      enabledModules: ALL_MODULES,
    });
    const auth = `Bearer ${token}`;
    const agent = request(app.getHttpServer());

    await agent.get("/dashboard/stats").set("Authorization", auth);
    expect(stats.getDashboardStats).toHaveBeenCalledWith(
      "org_alien",
      expect.objectContaining({ orgId: "org_alien", userId: "user_alien" }),
    );
    expect(stats.getDashboardStats).not.toHaveBeenCalledWith("org_1", expect.anything());

    await agent.get("/dashboard/announcements").set("Authorization", auth);
    expect(announcements.getActiveAnnouncements).toHaveBeenCalledWith("org_alien");

    await agent.get("/dashboard/personal").set("Authorization", auth);
    expect(personal.getPersonalDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_alien", userId: "user_alien" }),
    );

    await agent.get("/dashboard/executive").set("Authorization", auth);
    expect(crm.getExecutiveDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_alien" }),
    );
  });

  it("SUBJECT: /dashboard/my-issues ignores a client-supplied userId and reads the caller's own issues", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/dashboard/my-issues?userId=user_victim")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(project.getMyIssues).toHaveBeenCalledWith("org_1", "user_1");
  });
});

/**
 * PRD-C144 — "renders available sections without waiting for the slowest one".
 *
 * The client half of that promise is worth nothing if the aggregate 500s when
 * one source fails. `DashboardPersonalService` is REAL here; only the sources it
 * fans out to are broken, so the assertion is about the endpoint's own
 * behaviour: it must answer 200 and NAME the sections it could not fill, rather
 * than propagate the first rejection.
 */
describe("Dashboard degraded sections (e2e)", () => {
  let app: INestApplication;

  /*
   * `DrizzleModule.onApplicationBootstrap` runs one raw `execute` to check that
   * RLS is enforced, so the stub answers it with an empty result — that path
   * returns early on no row — and breaks only the two surfaces the personal
   * aggregate actually reads.
   */
  const brokenSources = {
    query: {
      organizationMembers: {
        findFirst: (): Promise<never> =>
          Promise.reject(new Error("membership source is down")),
      },
    },
    select: (): never => {
      throw new Error("relational source is down");
    },
  };

  const brokenDb = {
    ...brokenSources,
    execute: async (): Promise<Record<string, unknown>[]> => [],
    __client: { end: async (): Promise<void> => undefined },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ ...brokenSources, execute: async (): Promise<Record<string, unknown>[]> => [] }),
  };

  const project = {
    getMyIssues: jest.fn().mockRejectedValue(new Error("issue source is down")),
    getActiveSprintSummary: jest.fn().mockResolvedValue(null),
    getRecentActivity: jest.fn().mockResolvedValue([]),
    getRecentProjects: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: brokenDb },
        { provide: DashboardProjectService, useValue: project },
      ],
    });
  });

  afterAll(async () => app.close());

  it("answers 200 with the failing sections NAMED, instead of failing the whole page", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/dashboard/personal")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.degraded)).toBe(true);
    expect(res.body.degraded.length).toBeGreaterThan(0);
    expect(res.body.degraded).toEqual(expect.arrayContaining(["membership"]));
  });

  it("still returns every section's key, so a degraded section renders as 'could not load' and not as absent", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/dashboard/personal")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("myTasks");
    expect(res.body).toHaveProperty("timesheetStatus");
    expect(res.body).toHaveProperty("upcomingEvents");
  });

  it("BITE: a source that answers is NOT reported as degraded", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/dashboard/personal")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.degraded).not.toContain("modules");
  });
});
