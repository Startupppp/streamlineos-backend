import type { Db } from "../../db/drizzle.module";
import { DashboardAvailabilityService } from "./dashboard-availability.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(): object {
  const chain: Record<string, jest.Mock> = {};
  chain["orderBy"] = jest.fn().mockImplementation(() => chain);
  chain["limit"] = jest.fn().mockImplementation(() => Promise.resolve([]));
  chain["then"] = jest
    .fn()
    .mockImplementation((resolve: (rows: unknown[]) => unknown) => resolve([]));
  return chain;
}

function makeFrom(wheres: unknown[]): object {
  const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return makeChain(); });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  return self;
}

describe("DashboardAvailabilityService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const makeU = (orgId: string): CurrentUserContext =>
    ({ orgId, userId: "user-1" }) as CurrentUserContext;

  function makeDb(wheres: unknown[]) {
    return {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ timezone: "UTC" }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => makeFrom(wheres)),
      })),
    } as unknown as Db;
  }

  function makeAccess() {
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    } as never;
  }

  function makeCache() {
    return {
      cachedForOrg: jest.fn().mockImplementation((_org: unknown, _key: unknown, fn: () => unknown) => fn()),
    } as never;
  }

  it("scopes availability query to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new DashboardAvailabilityService(makeDb(wheres), makeCache(), makeAccess());

    await svc.getTeamAvailability(makeU(ATTACKER));

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns availability for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new DashboardAvailabilityService(makeDb(wheres), makeCache(), makeAccess());

    const result = await svc.getTeamAvailability(makeU(OWNER));

    expect(Array.isArray(result)).toBe(true);
  });
});
