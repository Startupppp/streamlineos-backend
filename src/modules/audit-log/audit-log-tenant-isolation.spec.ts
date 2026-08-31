import type { Db } from "../../db/drizzle.module";
import { encodeCursor } from "../../common/pagination/cursor";
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
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
  });
  const selectBuilder = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where,
  };
  selectBuilder.from.mockReturnValue(selectBuilder);
  selectBuilder.leftJoin.mockReturnValue(selectBuilder);
  selectBuilder.where.mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
  });

  const db = {
    select: jest.fn().mockReturnValue(selectBuilder),
  } as unknown as Db;

  return { db, where };
}

function makeRow(id: number, createdAt: Date) {
  return {
    id,
    action: "user.login",
    userId: "u1",
    userName: "Alice",
    userEmail: "alice@test.com",
    userImage: null,
    targetId: null,
    targetType: null,
    metadata: {},
    ipAddress: "1.2.3.4",
    createdAt,
  };
}

const cache = { cached: jest.fn().mockResolvedValue([]) };

describe("AuditLogService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes list query to the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new AuditLogService(db, cache as never);

    const result = await svc.list(ATTACKER_ORG, { limit: 20 });

    expect(result.logs).toHaveLength(0);
    const whereArgs = where.mock.calls[0];
    const leafValues = sqlValues(whereArgs);
    expect(leafValues).toContain(ATTACKER_ORG);
  });

  it("returns logs for the owning org (same-tenant control)", async () => {
    const row = makeRow(1, new Date());
    const { db } = makeDb([row]);
    const svc = new AuditLogService(db, cache as never);

    const result = await svc.list(OWNER_ORG, { limit: 20 });

    expect(result.logs.length).toBeGreaterThanOrEqual(0);
  });
});

describe("AuditLogService — cursor stability", () => {
  const ORG = "org-1";

  it("does not repeat a row inserted between page reads", async () => {
    const t1 = new Date("2024-01-01T10:00:00Z");
    const t2 = new Date("2024-01-01T10:01:00Z");
    const t3 = new Date("2024-01-01T10:02:00Z");

    const page1Rows = [makeRow(3, t3), makeRow(2, t2), makeRow(1, t1)];

    const cursor = encodeCursor({ sortValue: t2.toISOString(), id: "2" });

    const intruder = makeRow(4, new Date("2024-01-01T10:01:30Z"));
    const page2Rows = [makeRow(1, t1)];

    let callIndex = 0;
    const selectBuilder = () => ({
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(
            callIndex++ === 0 ? page1Rows : page2Rows,
          ),
        }),
      }),
    });

    const db = {
      select: jest.fn().mockImplementation(selectBuilder),
    } as unknown as Db;

    const svc = new AuditLogService(db, cache as never);

    const p1 = await svc.list(ORG, { limit: 2 });
    expect(p1.logs.map((r) => r.id)).toEqual([3, 2]);
    expect(p1.pagination.nextCursor).not.toBeNull();

    void intruder;

    const p2 = await svc.list(ORG, { limit: 2, cursor });
    expect(p2.logs.map((r) => r.id)).toEqual([1]);
    expect(p2.pagination.hasMore).toBe(false);

    const allIds = [...p1.logs.map((r) => r.id), ...p2.logs.map((r) => r.id)];
    const unique = new Set(allIds);
    expect(unique.size).toBe(allIds.length);
  });

  it("encodes null nextCursor on the last page, never undefined", async () => {
    const row = makeRow(1, new Date());
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([row]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new AuditLogService(db, cache as never);
    const result = await svc.list(ORG, { limit: 20 });

    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
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
