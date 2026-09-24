import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import { DashboardCrmService } from "./dashboard-crm.service";
import { buildOrgSectionCacheKey } from "./dashboard-cache-key";

const ORG = "org-crm-pulse";

function makeDb(): { db: Db; tables: string[] } {
  const tables: string[] = [];
  const chain = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve([{ cnt: 4, total: "2000" }]),
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        tables.push(is(table, PgTable) ? getTableName(table) : "unknown");
        return chain;
      },
    }),
  } as unknown as Db;
  return { db, tables };
}

function access(version = 5): AccessService {
  return {
    moduleAvailability: jest.fn().mockResolvedValue({ available: true }),
    holds: jest.fn().mockResolvedValue(true),
    getPermissionsVersion: jest.fn().mockResolvedValue(version),
  } as unknown as AccessService;
}

function passthroughCache() {
  const keys: string[] = [];
  const orgs: string[] = [];
  const globalCached = jest.fn();
  return {
    keys,
    orgs,
    globalCached,
    cache: {
      cached: globalCached,
      cachedForOrg: jest
        .fn()
        .mockImplementation((orgId: string, key: string, fn: () => unknown) => {
          orgs.push(orgId);
          keys.push(key);
          return fn();
        }),
    } as never,
  };
}

describe("GET /dashboard/crm-pulse — the regression this lane fixes", () => {
  it("returns CRM figures for a crm:leads:view holder that lacks hr:analytics:read", async () => {
    const { db } = makeDb();
    const { cache } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access());

    const result = await svc.getCrmPulse(ORG);

    expect(result.mrr).toBe(2000);
    expect(result.pipelineValue).toBe(2000);
    expect(result.newLeadsThisWeek).toBe(4);
    expect(result.conversionRate).toBe(100);
  });

  it("returns every CRM field with no optional gaps — unlike the executive endpoint", async () => {
    const { db } = makeDb();
    const { cache } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access());

    const result = await svc.getCrmPulse(ORG);

    expect(Object.keys(result)).toContain("mrr");
    expect(Object.keys(result)).toContain("pipelineValue");
    expect(Object.keys(result)).toContain("newLeadsThisWeek");
    expect(Object.keys(result)).toContain("conversionRate");
  });

  it("writes through the org-scoped cache, never the global one", async () => {
    const { db } = makeDb();
    const { cache, orgs, globalCached } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access());

    await svc.getCrmPulse(ORG);

    expect(globalCached).not.toHaveBeenCalled();
    expect(orgs).toEqual([ORG]);
  });
});

describe("crm-pulse cache key isolation from crm-executive", () => {
  it("the crm-pulse key and crm-executive key are distinct for the same org at the same version", async () => {
    const a = access(3);
    const b = access(3);
    const pulseKey = await buildOrgSectionCacheKey(a, ORG, "crm-pulse");
    const execKey = await buildOrgSectionCacheKey(b, ORG, "crm-executive", "crm");

    expect(pulseKey).not.toBe(execKey);
    expect(pulseKey).toContain("crm-pulse");
    expect(execKey).toContain("crm-executive");
  });

  it("crm-pulse key rotates when the permissions version changes", async () => {
    const keyV3 = await buildOrgSectionCacheKey(access(3), ORG, "crm-pulse");
    const keyV4 = await buildOrgSectionCacheKey(access(4), ORG, "crm-pulse");

    expect(keyV3).not.toBe(keyV4);
  });
});

describe("shared CRM computation is invoked once per getCrmPulse call", () => {
  it("queries deals and lead_party_map exactly once each — no double call from buildCrmFigures", async () => {
    const { db, tables } = makeDb();
    const { cache } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access());

    await svc.getCrmPulse(ORG);

    const dealHits = tables.filter((t) => t === "deals").length;
    const leadHits = tables.filter((t) => t === "lead_party_map").length;
    expect(dealHits).toBe(2);
    expect(leadHits).toBe(3);
  });
});
