import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import { DashboardCrmService } from "./dashboard-crm.service";

function denyCrmAccess(): AccessService {
  return {
    moduleAvailability: jest.fn().mockResolvedValue({ available: false }),
    holds: jest.fn().mockResolvedValue(false),
  } as unknown as AccessService;
}

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
    groupBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeFrom(wheres: unknown[]): object {
  const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return makeChain(); });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  return self;
}

describe("DashboardCrmService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(): { db: Db; wheres: unknown[] } {
    const wheres: unknown[] = [];
    const crmFindMany = jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
      if (opts.where) wheres.push(opts.where);
      return Promise.resolve([]);
    });
    const db = {
      select: jest.fn().mockImplementation(() => ({ from: jest.fn().mockImplementation(() => makeFrom(wheres)) })),
      query: { crmActivities: { findMany: crmFindMany } },
    } as unknown as Db;
    return { db, wheres };
  }

  it("scopes CRM activity queries to the requesting org (tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()), cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new DashboardCrmService(db, cache, denyCrmAccess());

    await svc.getTodayActivities(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    expect(wheres.flatMap(w => sqlValues(w))).toContain(ATTACKER);
  });

  it("returns CRM activities for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()), cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new DashboardCrmService(db, cache, denyCrmAccess());

    const result = await svc.getTodayActivities(OWNER);

    expect(result).toBeDefined();
  });
});

describe("DashboardCrmService.getCrmPulse — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeOrgDb(): { db: Db; wheres: unknown[] } {
    const wheres: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => {
          const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return Promise.resolve([{ cnt: 0, total: "0" }]); });
          const self: Record<string, jest.Mock> = { where };
          self["innerJoin"] = jest.fn().mockImplementation(() => ({ where }));
          self["leftJoin"] = jest.fn().mockImplementation(() => ({ where }));
          return self;
        }),
      })),
    } as unknown as Db;
    return { db, wheres };
  }

  function passthroughAccess(): AccessService {
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      moduleAvailability: jest.fn().mockResolvedValue({ available: true }),
      holds: jest.fn().mockResolvedValue(true),
    } as unknown as AccessService;
  }

  it("scopes getCrmPulse queries to the requesting org (tenant isolation)", async () => {
    const { db, wheres } = makeOrgDb();
    const cache = { cachedForOrg: jest.fn().mockImplementation((_orgId: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new DashboardCrmService(db, cache, passthroughAccess());

    await svc.getCrmPulse(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    expect(wheres.flatMap((w) => sqlValues(w))).toContain(ATTACKER);
  });

  it("does not leak OWNER data when queried as ATTACKER (cross-tenant control)", async () => {
    const { db: dbA, wheres: wheresA } = makeOrgDb();
    const { db: dbB, wheres: wheresB } = makeOrgDb();
    const cache = { cachedForOrg: jest.fn().mockImplementation((_orgId: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;

    await new DashboardCrmService(dbA, cache, passthroughAccess()).getCrmPulse(ATTACKER);
    await new DashboardCrmService(dbB, cache, passthroughAccess()).getCrmPulse(OWNER);

    expect(wheresA.flatMap((w) => sqlValues(w))).toContain(ATTACKER);
    expect(wheresA.flatMap((w) => sqlValues(w))).not.toContain(OWNER);
    expect(wheresB.flatMap((w) => sqlValues(w))).toContain(OWNER);
    expect(wheresB.flatMap((w) => sqlValues(w))).not.toContain(ATTACKER);
  });
});
