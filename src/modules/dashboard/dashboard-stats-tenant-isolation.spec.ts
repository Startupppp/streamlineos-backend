import type { Db } from "../../db/drizzle.module";
import { DashboardStatsService } from "./dashboard-stats.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    where: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

describe("DashboardStatsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const makeU = (orgId: string): CurrentUserContext =>
    ({ orgId, userId: "user-1" }) as CurrentUserContext;

  function makeDb(wheres: unknown[]) {
    return {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ id: OWNER, name: "Acme", slug: "acme" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return makeChain([{ count: 0 }]);
          }),
        }),
      })),
    } as unknown as Db;
  }

  function makeAccess() {
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      scopeFor: jest.fn().mockResolvedValue("none"),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    } as never;
  }

  function makeCache() {
    return {
      cachedForOrg: jest.fn().mockImplementation((_org: unknown, _key: unknown, fn: () => unknown) => fn()),
    } as never;
  }

  it("scopes all stat queries to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const db = makeDb(wheres);
    const svc = new DashboardStatsService(db, makeCache(), makeAccess());

    await svc.getDashboardStats(ATTACKER, makeU(ATTACKER));

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns stats for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const db = makeDb(wheres);
    const svc = new DashboardStatsService(db, makeCache(), makeAccess());

    const result = await svc.getDashboardStats(OWNER, makeU(OWNER));

    expect(result).toBeDefined();
    expect(result).toHaveProperty("orgName");
  });
});
