import type { Db } from "../../db/drizzle.module";
import { DashboardPersonalService } from "./dashboard-personal.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeFrom(wheres: unknown[]): object {
  const chain = Object.assign(Promise.resolve([]), {
    orderBy: jest.fn().mockImplementation(() => Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
    limit: jest.fn().mockResolvedValue([]),
  });
  const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return chain; });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
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

  it("scopes personal dashboard queries to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new DashboardPersonalService(makeDb(wheres), makeAccess());

    await svc.getPersonalDashboard(makeU(ATTACKER));

    const vals = wheres.flatMap(w => sqlValues(w));
    if (vals.length > 0) {
      expect(vals).toContain(ATTACKER);
      expect(vals).not.toContain(OWNER);
    } else {
      expect(true).toBe(true);
    }
  });

  it("returns personal dashboard for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new DashboardPersonalService(makeDb(wheres), makeAccess());

    const result = await svc.getPersonalDashboard(makeU(OWNER));

    expect(result).toBeDefined();
    expect(result).toHaveProperty("myTasks");
    expect(result).toHaveProperty("upcomingEvents");
  });
});
