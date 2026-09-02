import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { DashboardCrmService } from "./dashboard-crm.service";

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

function makeDb(): { db: Db; tables: string[] } {
  const tables: string[] = [];
  const chain = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve([{ cnt: 3, total: "1500" }]),
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

function access(available: boolean, holds: boolean): AccessService {
  return {
    moduleAvailability: jest.fn().mockResolvedValue({ available }),
    holds: jest.fn().mockResolvedValue(holds),
  } as unknown as AccessService;
}

function passthroughCache() {
  const keys: string[] = [];
  return {
    keys,
    cache: {
      cached: jest.fn().mockImplementation((key: string, fn: () => unknown) => {
        keys.push(key);
        return fn();
      }),
    } as never,
  };
}

describe("executive dashboard projection", () => {
  it("omits every CRM figure and reads no CRM table when the module is off", async () => {
    const { db, tables } = makeDb();
    const { cache, keys } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access(false, true));

    const result = await svc.getExecutiveDashboard(user());

    expect(result).toEqual({ headcount: 3, openRoles: 3, activeProjects: 3 });
    expect(result.mrr).toBeUndefined();
    expect(result.pipelineValue).toBeUndefined();
    expect(result.newLeadsThisWeek).toBeUndefined();
    expect(result.conversionRate).toBeUndefined();
    expect(tables).not.toContain("deals");
    expect(tables).not.toContain("lead_party_map");
    expect(keys[0]).toContain(":core");
  });

  it("omits every CRM figure when the caller lacks the CRM read permission", async () => {
    const { db, tables } = makeDb();
    const { cache } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access(true, false));

    const result = await svc.getExecutiveDashboard(user());

    expect(result.mrr).toBeUndefined();
    expect(tables).not.toContain("deals");
  });

  it("serves CRM figures to a caller holding the module and the permission", async () => {
    const { db, tables } = makeDb();
    const { cache, keys } = passthroughCache();
    const svc = new DashboardCrmService(db, cache, access(true, true));

    const result = await svc.getExecutiveDashboard(user());

    expect(result.headcount).toBe(3);
    expect(result.mrr).toBe(1500);
    expect(result.pipelineValue).toBe(1500);
    expect(result.newLeadsThisWeek).toBe(3);
    expect(result.conversionRate).toBe(100);
    expect(tables).toContain("deals");
    expect(keys[0]).toContain(":crm");
  });

  it("keys the two projections apart so a CRM-less answer is never served to a CRM caller", async () => {
    const denied = passthroughCache();
    const allowed = passthroughCache();
    await new DashboardCrmService(
      makeDb().db,
      denied.cache,
      access(false, false),
    ).getExecutiveDashboard(user());
    await new DashboardCrmService(
      makeDb().db,
      allowed.cache,
      access(true, true),
    ).getExecutiveDashboard(user());

    expect(denied.keys[0]).not.toBe(allowed.keys[0]);
  });
});
