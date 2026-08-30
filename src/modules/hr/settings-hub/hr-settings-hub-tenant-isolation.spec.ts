import type { Db } from "../../../db/drizzle.module";
import { HrSettingsHubService } from "./hr-settings-hub.service";

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
  return { db, where, findMany, findFirst };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock, findFirst?: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  if (findFirst && findFirst.mock.calls.length > 0) return (findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrSettingsHubService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("throws NotFoundException for cross-tenant policy version access (cross-tenant isolation)", async () => {
    const { db, where, findMany, findFirst } = makeDb([]);
    const mockEvaluation = { evaluatePolicy: jest.fn() };
    const svc = new HrSettingsHubService(db, mockEvaluation as never);
    await expect(svc.getVersions(ATTACKER, "policy", "99")).rejects.toThrow();
    expect(sqlValues(isolationArg(where, findMany, findFirst))).toContain(ATTACKER);
  });

  it("returns policy version lineage for owning org (control — same-tenant access works)", async () => {
    const ROOT = { id: 1, orgId: OWNER, name: "Leave Policy", policyType: "leave", replacedById: null, deletedAt: null };
    const { db, where, findMany, findFirst } = makeDb([ROOT]);
    const mockEvaluation = { evaluatePolicy: jest.fn() };
    const svc = new HrSettingsHubService(db, mockEvaluation as never);
    const result = await svc.getVersions(OWNER, "policy", "1");
    expect(sqlValues(isolationArg(where, findMany, findFirst))).toContain(OWNER);
    expect(result).toBeTruthy();
  });
});
