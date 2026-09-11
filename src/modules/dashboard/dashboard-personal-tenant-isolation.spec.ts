import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { DashboardPersonalService } from "./dashboard-personal.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DashboardProjectService } from "./dashboard-project.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

const aliasedSubquery = (alias: string) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (typeof prop === "string" ? sql.raw(`"${alias}"."${prop}"`) : undefined),
  });

function makeFrom(wheres: unknown[]): object {
  const chain = Object.assign(Promise.resolve([]), {
    orderBy: jest.fn().mockImplementation(() => Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
    limit: jest.fn().mockImplementation(() => Object.assign(Promise.resolve([]), { as: (alias: string) => aliasedSubquery(alias) })),
  });
  const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return chain; });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoinLateral"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  return self;
}

describe("DashboardPersonalService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const makeU = (orgId: string): CurrentUserContext =>
    ({ orgId, userId: "user-1" }) as CurrentUserContext;

  function makeDb(wheres: unknown[]) {
    return {
      query: {
        tickets: { findMany: jest.fn().mockResolvedValue([]) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: "member-iso-1" }) },
      },
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => makeFrom(wheres)),
      })),
    } as unknown as Db;
  }

  function makeAccess() {
    return {
      moduleAvailability: jest.fn().mockResolvedValue({ available: false }),
    } as never;
  }

  function makeProjectService() {
    return {
      getMyIssues: jest.fn().mockResolvedValue([]),
    } as unknown as DashboardProjectService;
  }

  it("scopes personal dashboard queries to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const projectSvc = makeProjectService();
    const svc = new DashboardPersonalService(makeDb(wheres), makeAccess(), projectSvc);

    await svc.getPersonalDashboard(makeU(ATTACKER));

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals.length).toBeGreaterThan(0);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
    // This used to read `notifService.unreadCount(ATTACKER, "user-1")`. That
    // branch was deleted as dead, and it was the only collaborator on this path
    // that was NOT module-gated — `makeAccess()` here reports every module
    // unavailable, so `getMyIssues` is never reached. The tenant binding is
    // still asserted above, on the SQL the service actually issued; what is
    // added here is the gate itself, which is the reason the call is absent.
    expect(projectSvc.getMyIssues).not.toHaveBeenCalled();
  });

  it("returns personal dashboard for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const projectSvc = makeProjectService();
    const svc = new DashboardPersonalService(makeDb(wheres), makeAccess(), projectSvc);

    const result = await svc.getPersonalDashboard(makeU(OWNER));

    expect(result).toBeDefined();
    expect(result).toHaveProperty("myTasks");
    expect(result).toHaveProperty("upcomingEvents");
    expect(result.degraded ?? []).not.toContain("upcomingEvents");
    expect(projectSvc.getMyIssues).not.toHaveBeenCalled();
  });
});
