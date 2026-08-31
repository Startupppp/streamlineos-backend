import type { Db } from "../../../db/drizzle.module";
import { RecurringInvoicesService } from "./recurring-invoices.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("RecurringInvoicesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(rows) }) }),
    });
    const countWhere = jest.fn().mockResolvedValue([{ count: rows.length }]);
    let call = 0;
    const select = jest.fn().mockImplementation(() => {
      call++;
      if (call % 2 === 1) return { from: jest.fn().mockReturnValue({ where }) };
      return { from: jest.fn().mockReturnValue({ where: countWhere }) };
    });
    const db = { select } as unknown as Db;
    return { db, where };
  }

  it("scopes list to the requesting org (tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new RecurringInvoicesService(db, {} as never, {} as never, {} as never);

    await svc.list(ATTACKER_ORG, { page: 1, pageSize: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns items for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG }]);
    const svc = new RecurringInvoicesService(db, {} as never, {} as never, {} as never);

    const result = await svc.list(OWNER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
  });
});
