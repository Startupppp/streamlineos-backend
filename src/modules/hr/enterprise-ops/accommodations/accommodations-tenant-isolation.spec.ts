import type { Db } from "../../../../db/drizzle.module";
import { AccommodationsService } from "./accommodations.service";

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
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst: jest.fn().mockResolvedValue(rows[0] ?? null) }) });
  const db = { select: jest.fn().mockReturnValue(builder), query: queryProxy, insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }), execute: jest.fn().mockResolvedValue(rows) } as unknown as Db;
  return { db, where, findMany };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("AccommodationsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: "acc-1", orgId: OWNER };

  it("hides accommodations from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockAudit = { log: jest.fn() };
    const svc = new AccommodationsService(db, mockAudit as never);
    await svc.list(ATTACKER, { limit: 10 }, false);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns accommodations for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockAudit = { log: jest.fn() };
    const svc = new AccommodationsService(db, mockAudit as never);
    await svc.list(OWNER, { limit: 10 }, false);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});
