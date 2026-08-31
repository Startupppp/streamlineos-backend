import type { Db } from "../../../db/drizzle.module";
import { AccountingPayablesQueryService } from "./accounting-payables-query.service";
import { AccountingReceivablesService } from "./accounting-receivables.service";

type QueryBuilder = {
  from: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
};

type CapturedDb = {
  readonly db: Db;
  readonly where: jest.Mock;
};

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
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function agingDb(): CapturedDb {
  const where = jest.fn();
  const query: QueryBuilder = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where,
  };
  query.from.mockReturnValue(query);
  query.leftJoin.mockReturnValue(query);
  query.where.mockResolvedValue([]);

  return {
    db: { select: jest.fn().mockReturnValue(query) } as unknown as Db,
    where,
  };
}

describe("accounting aging â€” cross-tenant isolation", () => {
  const attackerOrgId = "org-attacker";

  it("AccountingReceivablesService excludes another org's invoices before aging them", async () => {
    const captured = agingDb();
    const service = new AccountingReceivablesService(captured.db);

    const result = await service.agedReceivables(attackerOrgId, { asOf: "2026-08-29" });

    expect(result.rows).toEqual([]);
    expect(captured.where).toHaveBeenCalledTimes(1);
    expect(sqlValues(captured.where.mock.calls[0]?.[0])).toContain(attackerOrgId);
  });

  it("AccountingPayablesQueryService excludes another org's bills before aging them", async () => {
    const captured = agingDb();
    const service = new AccountingPayablesQueryService(captured.db);

    const result = await service.agedPayables(attackerOrgId, { asOf: "2026-08-29" });

    expect(result.rows).toEqual([]);
    expect(captured.where).toHaveBeenCalledTimes(1);
    expect(sqlValues(captured.where.mock.calls[0]?.[0])).toContain(attackerOrgId);
  });
});
