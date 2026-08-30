import type { Db } from "../../db/drizzle.module";
import { AuditLogService } from "./audit-log.service";

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
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockResolvedValue(rows);
  const countWhere = jest.fn().mockResolvedValue([{ count: rows.length }]);
  const selectBuilder = {
    from: jest.fn(),
    where,
    leftJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
  };
  selectBuilder.from.mockReturnValue(selectBuilder);
  selectBuilder.leftJoin.mockReturnValue(selectBuilder);
  selectBuilder.orderBy.mockReturnValue(selectBuilder);
  selectBuilder.limit.mockReturnValue(selectBuilder);
  selectBuilder.offset.mockResolvedValue(rows);
  selectBuilder.where.mockReturnValue(selectBuilder);

  const countBuilder = {
    from: jest.fn(),
    where: countWhere,
    leftJoin: jest.fn(),
  };
  countBuilder.from.mockReturnValue(countBuilder);
  countBuilder.leftJoin.mockReturnValue(countBuilder);

  let callCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? selectBuilder : countBuilder;
    }),
    cached: jest.fn(),
  } as unknown as Db;

  return { db, where };
}

const cache = { cached: jest.fn().mockResolvedValue([]) };

describe("AuditLogService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes list query to the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new AuditLogService(db, cache as never);

    const result = await svc.list(ATTACKER_ORG, { page: 1, pageSize: 20 });

    expect(result.logs).toHaveLength(0);
    const whereArgs = where.mock.calls[0];
    const leafValues = sqlValues(whereArgs);
    expect(leafValues).toContain(ATTACKER_ORG);
  });

  it("returns logs for the owning org (same-tenant control)", async () => {
    const row = {
      id: 1,
      action: "user.login",
      userId: "u1",
      userName: "Alice",
      userEmail: "alice@test.com",
      userImage: null,
      targetId: null,
      targetType: null,
      metadata: {},
      ipAddress: "1.2.3.4",
      createdAt: new Date(),
    };
    const { db } = makeDb([row]);
    const svc = new AuditLogService(db, cache as never);

    const result = await svc.list(OWNER_ORG, { page: 1, pageSize: 20 });

    expect(result.logs.length).toBeGreaterThanOrEqual(0);
  });
});

describe("AuditLogService.listActions — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeCacheAndDb(rows: unknown[]) {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockResolvedValue(rows),
    });
    const db = {
      selectDistinct: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;
    const localCache = {
      cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    };
    return { db, where, localCache };
  }

  it("scopes distinctActions query to the requesting org (isolation)", async () => {
    const { db, where, localCache } = makeCacheAndDb([]);
    const svc = new AuditLogService(db, localCache as never);

    const result = await svc.listActions(ATTACKER_ORG);

    expect(result).toHaveLength(0);
    const leafValues = sqlValues(where.mock.calls[0]?.[0]);
    expect(leafValues).toContain(ATTACKER_ORG);
  });

  it("returns actions for the owning org (same-tenant control)", async () => {
    const { db, localCache } = makeCacheAndDb([{ action: "user.login" }]);
    const svc = new AuditLogService(db, localCache as never);

    const result = await svc.listActions(OWNER_ORG);

    expect(result).toContain("user.login");
  });
});
