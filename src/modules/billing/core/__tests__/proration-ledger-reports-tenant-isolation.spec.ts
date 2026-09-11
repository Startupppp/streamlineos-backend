import type { Db } from "../../../../db/drizzle.module";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(db: unknown, fn: (tx: unknown) => Promise<T>, opts?: unknown) => {
    tenantOptions.push(opts);
    return fn(db);
  },
}));

import { ProrationLedgerReportsService } from "../proration-ledger-reports.service";

const tenantOptions: unknown[] = [];

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  where.mockReturnValue(builder);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("ProrationLedgerReportsService — cross-tenant isolation", () => {
  beforeEach(() => {
    tenantOptions.length = 0;
  });

  it("listUnreconciled scopes the predicate and the tenant transaction to the attacker's own org", async () => {
    const { db, where } = makeDb([]);
    const svc = new ProrationLedgerReportsService(db);

    const rows = await svc.listUnreconciled(ATTACKER_ORG);

    expect(rows).toEqual([]);
    const bound = sqlValues(where.mock.calls[0]?.[0]);
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).not.toContain(OWNER_ORG);
    expect(tenantOptions[0]).toEqual({ orgId: ATTACKER_ORG });
  });

  it("listUnreconciled caps the page at 100 however large a limit the caller asks for", async () => {
    const { db } = makeDb([]);
    const svc = new ProrationLedgerReportsService(db);

    await svc.listUnreconciled(OWNER_ORG, 10_000);

    const limitMock = (db.select as jest.Mock).mock.results[0]?.value as { limit: jest.Mock };
    expect(limitMock.limit).toHaveBeenCalledWith(100);
  });

  it("listForSubscription never reaches another org's lines even when handed that org's subscription id", async () => {
    const { db, where } = makeDb([]);
    const svc = new ProrationLedgerReportsService(db);

    const result = await svc.listForSubscription(ATTACKER_ORG, 4242);

    expect(result).toEqual({ lines: [], chargeMinor: 0, creditMinor: 0, netMinor: 0 });
    const bound = sqlValues(where.mock.calls[0]?.[0]);
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).toContain(4242);
    expect(bound).not.toContain(OWNER_ORG);
    expect(tenantOptions[0]).toEqual({ orgId: ATTACKER_ORG });
  });

  it("listForSubscription totals only the rows the org predicate returned (control — same tenant)", async () => {
    const { db } = makeDb([{ amountMinor: 900 }, { amountMinor: -250 }]);
    const svc = new ProrationLedgerReportsService(db);

    const result = await svc.listForSubscription(OWNER_ORG, 7);

    expect(result.chargeMinor).toBe(900);
    expect(result.creditMinor).toBe(-250);
    expect(result.netMinor).toBe(650);
    expect(tenantOptions[0]).toEqual({ orgId: OWNER_ORG });
  });

  it("sumForPeriod binds the requesting org into the aggregate predicate", async () => {
    const where = jest.fn().mockResolvedValue([{ netMinor: 0, lineCount: 0 }]);
    const builder: Record<string, unknown> = { from: jest.fn(), where };
    (builder.from as jest.Mock).mockReturnValue(builder);
    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    const svc = new ProrationLedgerReportsService(db);

    const result = await svc.sumForPeriod(
      ATTACKER_ORG,
      99,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    expect(result).toEqual({ netMinor: 0, lineCount: 0 });
    const bound = sqlValues(where.mock.calls[0]?.[0]);
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).not.toContain(OWNER_ORG);
    expect(tenantOptions[0]).toEqual({ orgId: ATTACKER_ORG });
  });
});
