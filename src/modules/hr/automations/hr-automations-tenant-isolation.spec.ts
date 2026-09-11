import type { Db } from "../../../db/drizzle.module";
import { HrAutomationEngineService } from "./hr-automation-engine.service";
import { HrWebhooksService } from "./hr-webhooks.service";

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
    from: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    groupBy: jest.fn(),
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
  const queryProxy = new Proxy({} as Record<string, unknown>, {
    get: () => ({ findMany, findFirst }),
  });
  const insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
  // `select({ total: count() })` is the envelope's COUNT half and must answer with a count
  // row, not the page rows — otherwise `total` reads as 0 whatever the table holds.
  const countBuilder = {
    from: jest.fn(),
    where: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ total: rows.length }]).then(resolve),
  };
  countBuilder.from.mockReturnValue(countBuilder);
  countBuilder.where.mockReturnValue(countBuilder);
  const select = jest.fn().mockImplementation((projection?: Record<string, unknown>) =>
    projection !== undefined && Object.keys(projection).length === 1 && "total" in projection
      ? countBuilder
      : builder,
  );
  const db = {
    select,
    query: queryProxy,
    insert,
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select, query: queryProxy, insert } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany, findFirst, countWhere: countBuilder.where };
}

function getIsolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  const firstFindManyCall = findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  return firstFindManyCall?.["where"];
}

describe("HrWebhooksService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("hides webhook subscriptions from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany, countWhere } = makeDb([]);
    const svc = new HrWebhooksService(db);
    await svc.listSubscriptions(ATTACKER, 10);
    const arg = getIsolationArg(where, findMany);
    expect(sqlValues(arg)).toContain(ATTACKER);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns subscriptions for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany, countWhere } = makeDb([ROW]);
    const svc = new HrWebhooksService(db);
    const result = await svc.listSubscriptions(OWNER, 10);
    const arg = getIsolationArg(where, findMany);
    expect(sqlValues(arg)).toContain(OWNER);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(OWNER);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

describe("HrAutomationEngineService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, name: "rule" };

  it("hides automation rules from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany, countWhere } = makeDb([]);
    const mockActions = { execute: jest.fn() };
    const svc = new HrAutomationEngineService(db, mockActions as never, null);
    await svc.listRules(ATTACKER, { limit: 10 });
    const arg = getIsolationArg(where, findMany);
    expect(sqlValues(arg)).toContain(ATTACKER);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns rules for owning org (control)", async () => {
    const { db, where, findMany, countWhere } = makeDb([ROW]);
    const mockActions = { execute: jest.fn() };
    const svc = new HrAutomationEngineService(db, mockActions as never, null);
    const result = await svc.listRules(OWNER, { limit: 10 });
    const arg = getIsolationArg(where, findMany);
    expect(sqlValues(arg)).toContain(OWNER);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(OWNER);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
