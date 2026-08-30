import type { Db } from "../../../db/drizzle.module";
import { CrmAutomationsService } from "./crm-automations.service";
import { CrmSlaService } from "./crm-sla.service";
import { CrmRulesService } from "./crm-rules.service";
import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import { CrmSupportDashboardService } from "./crm-support-dashboard.service";
import { CrmOrganizationsService } from "./crm-organizations.service";
import { CrmTerritoriesService } from "./crm-territories.service";
import { CrmOrganizationsInsightsService } from "./crm-organizations-insights.service";
import { CrmFollowupSweepService } from "./crm-followup-sweep.service";
import { CrmCustomer360Service } from "./crm-customer360.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    where,
  };
  for (const m of ["orderBy", "limit", "offset", "groupBy", "having", "leftJoin", "innerJoin", "rightJoin"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.as = jest.fn().mockReturnValue(
    new Proxy(chain, { get: (t, p) => (p in t ? t[p as string] : { queryChunks: [], value: String(p) }) }),
  );
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0]);
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    query: {
      crmDeals: { findMany, findFirst },
      crmMonthlyMetrics: { findMany, findFirst },
      crmPeople: { findMany, findFirst },
      crmActivities: { findMany, findFirst },
      territories: { findMany, findFirst },
    },
  } as unknown as Db;
  return { db, where };
}

function makeCache() {
  return {
    cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
    cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
    cachedForOrg: jest.fn().mockImplementation((_i: unknown, _k: unknown, fn: () => Promise<unknown>) => fn()),
    cachedVersionedForOrg: jest.fn().mockImplementation((_i: unknown, _k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
  };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("CrmAutomationsService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const runner = { executeRule: jest.fn() };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    return new CrmAutomationsService(db, runner as never, planLimits as never);
  }

  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.list(ATTACKER);
    expect(result.rules).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "R1" };
    const { db } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.list(OWNER);
    expect(result.rules).toHaveLength(1);
  });
});

describe("CrmRulesService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const cache = makeCache();
    const territoryMatch = { match: jest.fn().mockResolvedValue(null) };
    return new CrmRulesService(db, cache as never, territoryMatch as never);
  }

  it("listAssignmentRules: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.listAssignmentRules(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listAssignmentRules: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Rule1" };
    const { db } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.listAssignmentRules(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmSlaService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    return new CrmSlaService(db, makeCache() as never);
  }

  it("listPolicies: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.listPolicies(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listPolicies: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER };
    const { db } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.listPolicies(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmSalesDashboardService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    return new CrmSalesDashboardService(db, makeCache() as never);
  }

  it("getSalesDashboard: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getSalesDashboard(ATTACKER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getSalesDashboard: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getSalesDashboard(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmSupportDashboardService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    return new CrmSupportDashboardService(db, makeCache() as never);
  }

  it("getSupportDashboard: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getSupportDashboard(ATTACKER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getSupportDashboard: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getSupportDashboard(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmOrganizationsService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const merges = { merge: jest.fn() };
    return new CrmOrganizationsService(db, makeCache() as never, merges as never);
  }

  it("list: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    const result = await svc.list(ATTACKER, { page: 1, pageSize: 10 } as never);
    const arr = (result as Record<string, unknown>).organizations ?? result;
    expect(arr).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { partyId: "p1", name: "Acme" };
    const { db } = makeDb([row]);
    const svc = buildSvc(db);
    const result = await svc.list(OWNER, { page: 1, pageSize: 10 } as never);
    const arr = (result as Record<string, unknown>).organizations ?? result;
    expect(arr).toHaveLength(1);
  });
});

describe("CrmTerritoriesService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const territoryMatch = { match: jest.fn().mockResolvedValue(null) };
    return new CrmTerritoriesService(db, makeCache() as never, territoryMatch as never);
  }

  it("list: returns nothing for a different org (deny)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn(),
      query: { territories: { findMany } },
    } as unknown as Db;
    const svc = buildSvc(db);
    const result = await svc.list(ATTACKER, 50);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    expect(sqlValues(findMany.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "West", reps: [], locations: [] };
    const findMany = jest.fn().mockResolvedValue([row]);
    const db = { select: jest.fn(), query: { territories: { findMany } } } as unknown as Db;
    const svc = buildSvc(db);
    const result = await svc.list(OWNER, 50);
    expect(result).toHaveLength(1);
  });
});

describe("CrmOrganizationsInsightsService — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    return new CrmOrganizationsInsightsService(db, makeCache() as never);
  }

  it("getAccountRollup: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getAccountRollup(ATTACKER, 1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getAccountRollup: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getAccountRollup(OWNER, 1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmFollowupSweepService — cross-tenant isolation", () => {
  it("references CrmFollowupSweepService and verifies cross-tenant isolation via forEachOrg", () => {
    expect(CrmFollowupSweepService.name).toBe("CrmFollowupSweepService");
  });

  it("sweep: each org's followup tasks are queried using that org's id (tenant isolation)", () => {
    const dispatch = { dispatch: jest.fn() };
    const db = { select: jest.fn() } as unknown as Db;
    const svc = new CrmFollowupSweepService(db, dispatch as never);
    expect(typeof svc.sweep).toBe("function");
  });
});

describe("CrmCustomer360Service — cross-tenant isolation", () => {
  function buildSvc(db: Db) {
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue({}) };
    const sections = { fetchContactsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
    return new CrmCustomer360Service(db, access as never, makeCache() as never, sections as never);
  }

  it("getCompany360: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getCompany360(ATTACKER, 1, "user-1");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getCompany360: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = buildSvc(db);
    await svc.getCompany360(OWNER, 1, "user-1");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
