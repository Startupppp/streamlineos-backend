import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { CrmProductsService } from "./crm-products.service";
import { CrmCampaignsService } from "./crm-campaigns.service";
import { CrmWebFormsService } from "./crm-web-forms.service";
import { CrmAttributionReportService } from "./crm-attribution-report.service";
import { CrmCustomer360EngagementService } from "./crm-customer360-engagement.service";
import { SlaResolverService } from "./sla-resolver.service";
import { TerritoryMatchService } from "./territory-match.service";
import { CrmPeopleService } from "./crm-people.service";

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
  // A grouped read can end in `.as()` instead of being awaited: the attribution
  // report reduces the touch log to one row per `(campaign, lead)` as a
  // subquery before any deal is joined. A subquery is only ever read from, so a
  // bare object stands in for it -- its predicate was already recorded by `where`.
  chain.as = jest.fn().mockReturnValue({});
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("CrmProductsService — cross-tenant isolation", () => {
  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmProductsService(db);
    const result = await svc.list(ATTACKER);
    expect(result.products).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "P1" };
    const { db } = makeDb([row]);
    const svc = new CrmProductsService(db);
    const result = await svc.list(OWNER);
    expect(result.products).toHaveLength(1);
  });
});

describe("CrmCampaignsService — cross-tenant isolation (mutation guard)", () => {
  function makeUpdateDb(returning: unknown[]): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue(returning),
    });
    const db = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;
    return { db, where };
  }

  it("remove: throws NotFoundException when campaign belongs to a different org (deny)", async () => {
    const { db, where } = makeUpdateDb([]);
    const svc = new CrmCampaignsService(db);
    await expect(svc.remove(ATTACKER, 99)).rejects.toThrow(NotFoundException);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("remove: succeeds for the owning org (control)", async () => {
    const { db } = makeUpdateDb([{ id: 99 }]);
    const svc = new CrmCampaignsService(db);
    const result = await svc.remove(OWNER, 99);
    expect(result).toEqual({ success: true });
  });
});

describe("CrmWebFormsService — cross-tenant isolation", () => {
  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmWebFormsService(db);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: "f1", orgId: OWNER, name: "Form" };
    const { db } = makeDb([row]);
    const svc = new CrmWebFormsService(db);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmAttributionReportService — cross-tenant isolation", () => {
  it("getFirstTouchAttribution: queries scoped to attacker yield empty attribution (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmAttributionReportService(db);
    const result = await svc.getFirstTouchAttribution(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    // Three filtered reads -- the won stage keys, the touch grain and the won
    // revenue per lead -- and the last two are subqueries with no outer WHERE to
    // inherit a tenant from, so each must carry its own.
    expect(where).toHaveBeenCalledTimes(3);
    for (const [predicate] of where.mock.calls) expect(sqlValues(predicate)).toContain(ATTACKER);
  });

  it("getFirstTouchAttribution: returns attributions for the owning org (control)", async () => {
    const row = { campaignId: 1, campaignName: "C", touchCount: 2, convertedLeads: 1, totalRevenue: 1000, spend: 100 };
    const { db } = makeDb([row]);
    const svc = new CrmAttributionReportService(db);
    const result = await svc.getFirstTouchAttribution(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CrmCustomer360EngagementService — cross-tenant isolation", () => {
  it("fetchSupportTicketsForOrg: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmCustomer360EngagementService(db);
    const result = await svc.fetchSupportTicketsForOrg(ATTACKER);
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("fetchSupportTicketsForOrg: returns rows for the owning org (control)", async () => {
    const row = { id: 1, title: "T1", status: "open", priority: "high", createdAt: new Date() };
    const { db } = makeDb([row]);
    const svc = new CrmCustomer360EngagementService(db);
    const result = await svc.fetchSupportTicketsForOrg(OWNER);
    expect(result.items).toHaveLength(1);
  });
});

describe("SlaResolverService — cross-tenant isolation", () => {
  it("resolve: returns null for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new SlaResolverService(db);
    const result = await svc.resolve(ATTACKER, { appliesTo: "lead" });
    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("resolve: returns policy row for the owning org (control)", async () => {
    const row = { id: 1, name: "SLA1", conditions: {}, targetMinutes: 60, firstResponseHours: 1, businessHours: false, appliesToText: null, priorityText: null };
    const { db } = makeDb([row]);
    const svc = new SlaResolverService(db);
    const result = await svc.resolve(OWNER, { appliesTo: "lead" });
    expect(result).toBeDefined();
  });
});

describe("TerritoryMatchService — cross-tenant isolation", () => {
  it("match: queries scoped to attacker yield no territory (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new TerritoryMatchService(db);
    const result = await svc.match(ATTACKER, { country: "US" });
    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("match: returns territory for the owning org (control)", async () => {
    const territory = { id: 1, name: "West", priority: 1, criteria: {} };
    const where2 = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const chain2: Record<string, unknown> = {
      then: (fn: (v: unknown) => unknown) => Promise.resolve([territory]).then(fn),
      where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([territory]) }) }),
      orderBy: jest.fn(),
      limit: jest.fn(),
    };
    ((chain2["orderBy"] as jest.Mock)).mockReturnValue({ limit: jest.fn().mockResolvedValue([territory]) });
    const from2 = jest.fn().mockReturnValueOnce(chain2).mockReturnValue({ where: where2 });
    const db = { select: jest.fn().mockReturnValue({ from: from2 }) } as unknown as Db;
    const svc = new TerritoryMatchService(db);
    const result = await svc.match(OWNER, {});
    expect(result?.territory).toBeDefined();
  });
});

describe("CrmPeopleService — cross-tenant isolation", () => {
  it("getAllPeopleSlugs: returns empty for a different org (deny)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { query: { crmPeople: { findMany } } } as unknown as Db;
    const svc = new CrmPeopleService(db);
    const result = await svc.getAllPeopleSlugs(ATTACKER, "all");
    expect(Object.keys(result)).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    expect(sqlValues(findMany.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("getAllPeopleSlugs: returns slug map for the owning org (control)", async () => {
    const row = { slug: "john-d", name: "John Doe" };
    const findMany = jest.fn().mockResolvedValue([row]);
    const db = { query: { crmPeople: { findMany } } } as unknown as Db;
    const svc = new CrmPeopleService(db);
    const result = await svc.getAllPeopleSlugs(OWNER, "all");
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
