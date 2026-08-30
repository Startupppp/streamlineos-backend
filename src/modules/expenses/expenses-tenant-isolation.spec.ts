import type { Db } from "../../db/drizzle.module";
import { ExpensesService } from "./expenses.service";
import { ExpenseLifecycleService } from "./expense-lifecycle.service";
import { TravelService } from "./travel.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeBuilder(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where,
    limit: jest.fn(),
    offset: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
    groupBy: jest.fn(),
    for: jest.fn(),
    returning: jest.fn().mockResolvedValue(rows),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown[]) => void) => Promise.resolve(rows).then(resolve),
    ),
  };
  for (const key of ["from", "where", "limit", "offset", "orderBy", "leftJoin", "groupBy", "for"]) {
    (builder[key] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where: where as jest.Mock };
}

function makeInsertBuilder(rows: unknown[] = [{ id: 1 }]) {
  const ib: Record<string, unknown> = {
    values: jest.fn(),
    onConflictDoNothing: jest.fn(),
    onConflictDoUpdate: jest.fn(),
    returning: jest.fn().mockResolvedValue(rows),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
    ),
  };
  (ib.values as jest.Mock).mockReturnValue(ib);
  (ib.onConflictDoNothing as jest.Mock).mockReturnValue(ib);
  (ib.onConflictDoUpdate as jest.Mock).mockReturnValue(ib);
  return ib;
}

function makeDb(rows: unknown[] = []) {
  const { builder, where } = makeBuilder(rows);

  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: {
      expenses: {
        findMany: jest.fn().mockResolvedValue(rows),
        findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
      },
      expenseCategories: { findMany: jest.fn().mockResolvedValue([]) },
      travelRequests: {
        findMany: jest.fn().mockResolvedValue(rows),
        findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
      },
    },
    insert: jest.fn().mockReturnValue(makeInsertBuilder()),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;
  return { db, where };
}

const mockCache = {
  cachedVersioned: jest.fn().mockImplementation((_ns: string, _k: string, fn: () => unknown) => fn()),
  invalidateNamespace: jest.fn(),
};
const mockAudit = { log: jest.fn() };
const mockPosting = { postExpense: jest.fn(), journalExpense: jest.fn() };

describe("ExpensesService — cross-tenant isolation", () => {
  it("list: count query contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ count: "0" }]) }),
    });
    (db.query.expenses.findMany as jest.Mock).mockResolvedValue([]);
    const svc = new ExpensesService(db, mockCache as never, mockAudit as never);
    const result = await svc.list(ATTACKER_ORG, "user-x", false, { page: 1, limit: 20 } as never);
    expect((result as { data: unknown[] }).data).toHaveLength(0);
    void where;
  });

  it("list: returns expenses for own org (control — same-tenant)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, userId: "u", amount: "100", status: "DRAFT", expenseDate: "2025-01-01", category: "Travel" };
    const { db } = makeDb([row]);
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ count: "1" }]) }),
    });
    (db.query.expenses.findMany as jest.Mock).mockResolvedValue([row]);
    const svc = new ExpensesService(db, mockCache as never, mockAudit as never);
    const result = await svc.list(OWNER_ORG, "u", false, { page: 1, limit: 20 } as never);
    expect((result as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("ExpenseLifecycleService — cross-tenant isolation", () => {
  it("checkDuplicate: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new ExpenseLifecycleService(db, mockCache as never, mockAudit as never, mockPosting as never);
    await svc.checkDuplicate(ATTACKER_ORG, "abc123hash");
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("checkDuplicate: returns null for own org with no duplicate (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new ExpenseLifecycleService(db, mockCache as never, mockAudit as never, mockPosting as never);
    const result = await svc.checkDuplicate(OWNER_ORG, "abc123hash");
    expect(result).toBeNull();
  });
});

describe("TravelService — cross-tenant isolation", () => {
  it("listMine: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      query: { travelRequests: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) } },
    } as unknown as Db;
    const svc = new TravelService(db);
    const result = await svc.listMine(ATTACKER_ORG, "user-x");
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("listMine: returns requests for own org (control — same-tenant)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, userId: "u", destination: "NYC", purpose: "Conf", startDate: "2025-01-01", endDate: "2025-01-05", status: "PENDING" };
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([row]) }),
    });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      query: { travelRequests: { findMany: jest.fn().mockResolvedValue([row]), findFirst: jest.fn().mockResolvedValue(row) } },
    } as unknown as Db;
    const svc = new TravelService(db);
    const result = await svc.listMine(OWNER_ORG, "u");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1 });
  });
});
