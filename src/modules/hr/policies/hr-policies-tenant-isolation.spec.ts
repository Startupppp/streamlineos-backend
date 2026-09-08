import type { Db } from "../../../db/drizzle.module";
import { HrPoliciesService } from "./hr-policies.service";
import { HrPolicyConflictService } from "./hr-policy-conflict.service";

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
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrPoliciesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, status: "active" };

  it("scopes policy list to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockCache = { cached: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()) };
    const mockEvaluation = { evaluate: jest.fn() };
    const mockConflicts = { detectConflicts: jest.fn().mockResolvedValue({ conflicts: [] }) };
    const svc = new HrPoliciesService(db, mockCache as never, mockEvaluation as never, mockConflicts as never);
    await svc.list(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns policies for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockCache = { cached: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()) };
    const mockEvaluation = { evaluate: jest.fn() };
    const mockConflicts = { detectConflicts: jest.fn().mockResolvedValue({ conflicts: [] }) };
    const svc = new HrPoliciesService(db, mockCache as never, mockEvaluation as never, mockConflicts as never);
    await svc.list(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrPolicyConflictService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, status: "active", scopes: [] };

  it("scopes org conflict detection to attacker org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrPolicyConflictService(db);
    await svc.detectOrgConflicts(ATTACKER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns org conflicts for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrPolicyConflictService(db);
    await svc.detectOrgConflicts(OWNER);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
