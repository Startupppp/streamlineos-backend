import type { Db } from "../../../../db/drizzle.module";
import { HrChecklistReconciliationService } from "./hr-checklist-reconciliation.service";
import { ModuleChecklistService } from "./module-checklist.service";

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
  const txDb = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(txDb)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function allArgs(where: jest.Mock, findFirst: jest.Mock, findMany?: jest.Mock): unknown[] {
  const wh = where.mock.calls.flatMap((c) => sqlValues(c[0]));
  const ff = findFirst.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"]));
  const fm = findMany ? findMany.mock.calls.flatMap((c) => sqlValues((c[0] as Record<string, unknown> | undefined)?.["where"])) : [];
  return [...wh, ...ff, ...fm];
}

describe("HrChecklistReconciliationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes signal computation to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new HrChecklistReconciliationService(db);
    await svc.reconcile(ATTACKER, []);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes signal computation to owner org (control — same-tenant access works)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const svc = new HrChecklistReconciliationService(db);
    await svc.reconcile(OWNER, []);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });
});

describe("ModuleChecklistService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes checklist list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockAnalytics = { track: jest.fn().mockResolvedValue(undefined) };
    const mockHrReconciliation = { reconcile: jest.fn().mockResolvedValue(false) };
    const mockEntitlements = { listModules: jest.fn().mockResolvedValue([]) };
    const svc = new ModuleChecklistService(db, mockAnalytics as never, mockHrReconciliation as never, mockEntitlements as never);
    await svc.listChecklists(ATTACKER, false);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });

  it("scopes checklist list to owner org (control — same-tenant access works)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockAnalytics = { track: jest.fn().mockResolvedValue(undefined) };
    const mockHrReconciliation = { reconcile: jest.fn().mockResolvedValue(false) };
    const mockEntitlements = { listModules: jest.fn().mockResolvedValue([{ moduleKey: "hr", enabled: true }]) };
    const svc = new ModuleChecklistService(db, mockAnalytics as never, mockHrReconciliation as never, mockEntitlements as never);
    await svc.listChecklists(OWNER, false);
    expect(allArgs(where, findFirst, findMany)).toContain(OWNER);
  });

  it("scopes ensureChecklistsForModules to org (cross-tenant isolation — no cross-org seeding)", async () => {
    const { db, where, findFirst, findMany } = makeDb([]);
    const mockAnalytics = { track: jest.fn().mockResolvedValue(undefined) };
    const mockHrReconciliation = { reconcile: jest.fn().mockResolvedValue(false) };
    const mockEntitlements = { listModules: jest.fn().mockResolvedValue([]) };
    const svc = new ModuleChecklistService(db, mockAnalytics as never, mockHrReconciliation as never, mockEntitlements as never);
    await svc.ensureChecklistsForModules(ATTACKER, ["hr"]);
    expect(allArgs(where, findFirst, findMany)).toContain(ATTACKER);
  });
});
