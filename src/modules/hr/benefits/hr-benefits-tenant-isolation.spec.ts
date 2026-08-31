import type { Db } from "../../../db/drizzle.module";
import { HrTravelVisitsService } from "./hr-travel-visits.service";

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
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  return { db, where, findMany };
}

describe("HrTravelVisitsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, travelRequestId: 10 };

  it("hides travel visits from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrTravelVisitsService(db);
    await svc.listVisits(ATTACKER, 10);
    const arg = where.mock.calls[0]?.[0] ?? (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
    expect(sqlValues(arg)).toContain(ATTACKER);
  });

  it("returns travel visits for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrTravelVisitsService(db);
    await svc.listVisits(OWNER, 10);
    const arg = where.mock.calls[0]?.[0] ?? (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
    expect(sqlValues(arg)).toContain(OWNER);
  });
});
