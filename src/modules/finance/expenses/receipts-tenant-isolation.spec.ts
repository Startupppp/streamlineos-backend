import type { Db } from "../../../db/drizzle.module";
import { ReceiptsService } from "./receipts.service";

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

describe("ReceiptsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: ReceiptsService; findMany: jest.Mock } {
    const findMany = jest.fn().mockResolvedValue(rows);
    const countWhere = jest.fn().mockResolvedValue([{ total: rows.length }]);
    const db = {
      query: { expenses: { findMany } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: countWhere }) }),
    } as unknown as Db;
    const svc = new ReceiptsService(db, {} as never, {} as never);
    return { svc, findMany };
  }

  it("scopes receipt list to the requesting org (tenant isolation)", async () => {
    const { svc, findMany } = makeService([]);

    await svc.listReceiptInbox(ATTACKER_ORG, { page: 1, pageSize: 20 });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(sqlValues(findMany.mock.calls[0]?.[0]?.where)).toContain(ATTACKER_ORG);
  });

  it("returns receipts for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.listReceiptInbox(OWNER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
  });
});
