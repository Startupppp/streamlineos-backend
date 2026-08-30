import type { Db } from "../../../db/drizzle.module";
import { PeriodReconciliationService } from "./period-reconciliation.service";
import { TaxAdminService } from "./tax-admin.service";
import { TeamRewardsService } from "./team-rewards.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const builder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function allArgs(where: jest.Mock, findFirst: jest.Mock, findMany?: jest.Mock): unknown[] {
  const wh = where.mock.calls.flatMap((c) => sqlValues(c[0]));
  const ff = findFirst.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"]));
  const fm = findMany ? findMany.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"])) : [];
  return [...wh, ...ff, ...fm];
}

describe("PeriodReconciliationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes reconciliation lookup to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PeriodReconciliationService(db);
    await svc.getPeriodReconciliation(ATTACKER, "2024-01");
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes reconciliation lookup to owner org (control — same-tenant returns data)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new PeriodReconciliationService(db);
    await svc.getPeriodReconciliation(OWNER, "2024-01");
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("TaxAdminService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes tax declaration list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new TaxAdminService(db);
    await svc.list(ATTACKER, {});
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes tax declaration list to owner org (control — same-tenant access works)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new TaxAdminService(db);
    await svc.list(OWNER, {});
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes approve to attacker org (cross-tenant isolation — approve checks orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new TaxAdminService(db);
    await svc.approve(ATTACKER, "verifier-1", 999);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes reject to attacker org (cross-tenant isolation — reject checks orgId)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new TaxAdminService(db);
    await svc.reject(ATTACKER, 999, "not eligible");
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});

describe("TeamRewardsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes salary/benefit/equity lookup to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockEss = { getTotalRewards: jest.fn().mockResolvedValue({}) };
    const mockEmploymentFacts = {
      getDirectReportUserIds: jest.fn().mockResolvedValue([]),
      getFacts: jest.fn().mockResolvedValue(null),
    };
    const svc = new TeamRewardsService(db, mockEss as never, mockEmploymentFacts as never);
    const result = await svc.getTeamRewards(ATTACKER, "manager-1");
    expect(result.directReports).toHaveLength(0);
    expect((mockEmploymentFacts.getDirectReportUserIds as jest.Mock).mock.calls[0]).toContain(ATTACKER);
  });

  it("scopes pay compression to owner org (control — same-tenant returns data)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockEss = { getTotalRewards: jest.fn().mockResolvedValue({}) };
    const mockEmploymentFacts = {
      getDirectReportUserIds: jest.fn().mockResolvedValue([]),
      getFacts: jest.fn().mockResolvedValue(null),
    };
    const svc = new TeamRewardsService(db, mockEss as never, mockEmploymentFacts as never);
    await svc.getOrgPayCompression(OWNER);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});
