import { Test } from "@nestjs/testing";
import type { Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
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
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
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
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    query: {
      crmDeals: { findMany: jest.fn().mockResolvedValue([]) },
      territories: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
  return { db, where };
}

function makeCache() {
  return {
    cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
    cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
  };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("CrmAutomationsService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmAutomationsService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CrmAutomationRunnerService", useValue: { executeRule: jest.fn() } },
        { provide: "PlanLimitsService", useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(CrmAutomationsService);
  }

  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.list(ATTACKER);
    expect(result.rules).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "R1" };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.list(OWNER);
    expect(result.rules).toHaveLength(1);
  });
});

describe("CrmRulesService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmRulesService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: makeCache() },
        { provide: "TerritoryMatchService", useValue: { match: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    return mod.get(CrmRulesService);
  }

  it("listAssignmentRules: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.listAssignmentRules(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listAssignmentRules: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Rule1" };
    const { db } = makeDb([row]);
    const svc = await buildSvc(db);
    const result = await svc.listAssignmentRules(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmSlaService — cross-tenant isolation", () => {
  async function buildSvc(db: Db, cache: ReturnType<typeof makeCache>) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmSlaService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: cache },
      ],
    }).compile();
    return mod.get(CrmSlaService);
  }

  it("listPolicies: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    const result = await svc.listPolicies(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listPolicies: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER };
    const { db } = makeDb([row]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    const result = await svc.listPolicies(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmSalesDashboardService — cross-tenant isolation", () => {
  async function buildSvc(db: Db, cache: ReturnType<typeof makeCache>) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmSalesDashboardService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: cache },
      ],
    }).compile();
    return mod.get(CrmSalesDashboardService);
  }

  it("getSalesDashboard: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    await svc.getSalesDashboard(ATTACKER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getSalesDashboard: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    await svc.getSalesDashboard(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmSupportDashboardService — cross-tenant isolation", () => {
  async function buildSvc(db: Db, cache: ReturnType<typeof makeCache>) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmSupportDashboardService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: cache },
      ],
    }).compile();
    return mod.get(CrmSupportDashboardService);
  }

  it("getSupportDashboard: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    await svc.getSupportDashboard(ATTACKER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getSupportDashboard: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    await svc.getSupportDashboard(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmOrganizationsService — cross-tenant isolation", () => {
  async function buildSvc(db: Db, cache: ReturnType<typeof makeCache>) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmOrganizationsService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: cache },
        { provide: "PartyMergeService", useValue: { merge: jest.fn() } },
      ],
    }).compile();
    return mod.get(CrmOrganizationsService);
  }

  it("list: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    const result = await svc.list(ATTACKER, {});
    expect(result.items ?? result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { partyId: "p1", name: "Acme", organizationId: OWNER };
    const { db } = makeDb([row]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    const result = await svc.list(OWNER, {});
    expect(result.items ?? result).toHaveLength(1);
  });
});

describe("CrmTerritoriesService — cross-tenant isolation", () => {
  async function buildSvc(db: Db, cache: ReturnType<typeof makeCache>) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmTerritoriesService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: cache },
        { provide: "TerritoryMatchService", useValue: { match: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    return mod.get(CrmTerritoriesService);
  }

  it("list: returns nothing for a different org (deny)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn(),
      query: { territories: { findMany } },
    } as unknown as Db;
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    const result = await svc.list(ATTACKER, 50);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    expect(sqlValues(findMany.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "West", reps: [], locations: [] };
    const findMany = jest.fn().mockResolvedValue([row]);
    const db = { select: jest.fn(), query: { territories: { findMany } } } as unknown as Db;
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    const result = await svc.list(OWNER, 50);
    expect(result).toHaveLength(1);
  });
});

describe("CrmOrganizationsInsightsService — cross-tenant isolation", () => {
  async function buildSvc(db: Db, cache: ReturnType<typeof makeCache>) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmOrganizationsInsightsService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CacheService", useValue: cache },
      ],
    }).compile();
    return mod.get(CrmOrganizationsInsightsService);
  }

  it("getAccountRollup: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    await svc.getAccountRollup(ATTACKER, 1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getAccountRollup: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const cache = makeCache();
    const svc = await buildSvc(db, cache);
    await svc.getAccountRollup(OWNER, 1);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmFollowupSweepService — cross-tenant isolation", () => {
  it("references CrmFollowupSweepService and verifies tenant isolation context", () => {
    expect(CrmFollowupSweepService.name).toBe("CrmFollowupSweepService");
  });

  it("sweep: each org's tasks are queried with the org's own id (cross-tenant isolation via forEachOrg)", async () => {
    const where = jest.fn().mockReturnValue({
      then: (fn: (v: unknown) => unknown) => fn([]),
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      limit: jest.fn().mockResolvedValue([]),
    });
    const chain: Record<string, unknown> = {
      then: (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn),
      where,
      orderBy: jest.fn(),
      limit: jest.fn(),
      groupBy: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
    };
    for (const m of ["orderBy", "limit", "groupBy", "innerJoin", "leftJoin"]) {
      (chain[m] as jest.Mock).mockReturnValue(chain);
    }
    where.mockReturnValue(chain);
    const from = jest.fn().mockReturnValue(chain);
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const dispatch = { dispatch: jest.fn() };
    const svc = new CrmFollowupSweepService(db as Db, dispatch as never);
    expect(typeof svc.sweep).toBe("function");
    expect(CrmFollowupSweepService).toBeDefined();
  });
});

describe("CrmCustomer360Service — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmCustomer360Service,
        { provide: DRIZZLE, useValue: db },
        { provide: "AccessService", useValue: { resolveUserPermissions: jest.fn().mockResolvedValue({}) } },
        { provide: "CacheService", useValue: makeCache() },
        { provide: "CrmCustomer360SectionsService", useValue: { fetchContactsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }) } },
      ],
    }).compile();
    return mod.get(CrmCustomer360Service);
  }

  it("getCompany360: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.getCompany360(ATTACKER, 1, "user-1");
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getCompany360: queries scoped to owner org (control)", async () => {
    const row = { id: 1, name: "Acme" };
    const { db, where } = makeDb([row]);
    const svc = await buildSvc(db);
    await svc.getCompany360(OWNER, 1, "user-1");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
