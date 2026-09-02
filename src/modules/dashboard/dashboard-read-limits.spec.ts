import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { DashboardAvailabilityService } from "./dashboard-availability.service";
import { DashboardProjectService } from "./dashboard-project.service";
import {
  boundedDashboardList,
  DASHBOARD_ATTENDANCE_ROW_CAP,
  DASHBOARD_LIST_CAP,
  DASHBOARD_PROJECT_ID_CAP,
} from "./dashboard-read-limits";

const ORG = "org-1";

function user(): CurrentUserContext {
  return {
    userId: "u1",
    orgId: ORG,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function allScopeAccess(): AccessService {
  return {
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(new Map([["hr:attendance:view", "all"]])),
    scopeFor: jest.fn().mockResolvedValue("all"),
    holds: jest.fn().mockResolvedValue(true),
  } as unknown as AccessService;
}

describe("boundedDashboardList", () => {
  it("caps the page and reports the untruncated total", () => {
    const rows = Array.from({ length: 250 }, (_v, i) => i);
    const page = boundedDashboardList(rows, 250);
    expect(page.data).toHaveLength(DASHBOARD_LIST_CAP);
    expect(page.total).toBe(250);
    expect(page.hasMore).toBe(true);
  });

  it("reports no truncation when the whole set fits", () => {
    const page = boundedDashboardList([1, 2, 3], 3);
    expect(page.data).toEqual([1, 2, 3]);
    expect(page.hasMore).toBe(false);
  });
});

describe("dashboard attendance reads are bounded", () => {
  function attendanceService(limits: number[]) {
    const chain = {
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: (n: number) => {
        limits.push(n);
        return Promise.resolve([]);
      },
      then: (resolve: (rows: unknown[]) => unknown) =>
        resolve([{ present: 12, clockedIn: 5 }]),
    };
    const db = {
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue({ timezone: "UTC" }) },
      },
      select: () => ({ from: () => chain }),
    } as unknown as Db;
    const cache = {
      cachedForOrg: jest
        .fn()
        .mockImplementation((_o: unknown, _k: unknown, fn: () => unknown) => fn()),
    } as never;
    return new DashboardAvailabilityService(db, cache, allScopeAccess());
  }

  it("caps the team-availability read", async () => {
    const limits: number[] = [];
    await attendanceService(limits).getTeamAvailability(user());
    expect(limits).toContain(DASHBOARD_ATTENDANCE_ROW_CAP);
  });

  it("caps the team-attendance read and takes its counts from a separate aggregate", async () => {
    const limits: number[] = [];
    const result = await attendanceService(limits).getTeamAttendance(user());
    expect(limits).toContain(DASHBOARD_ATTENDANCE_ROW_CAP);
    expect(result.present).toBe(12);
    expect(result.clockedIn).toBe(5);
    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(true);
  });
});

describe("dashboard project id resolution is bounded", () => {
  it("caps the org-wide project id list that feeds the IN clause", async () => {
    let limitArg: number | undefined;
    const db = {
      query: {
        projects: {
          findMany: jest.fn().mockImplementation((opts: { limit?: number }) => {
            limitArg = opts.limit;
            return Promise.resolve([]);
          }),
        },
      },
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
          }),
        }),
      }),
    } as unknown as Db;
    const service = new DashboardProjectService(db, allScopeAccess());

    await service.getRecentActivity(ORG, user());

    expect(limitArg).toBe(DASHBOARD_PROJECT_ID_CAP);
  });
});
