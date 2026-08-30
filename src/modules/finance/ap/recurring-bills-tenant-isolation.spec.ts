import type { Db } from "../../../db/drizzle.module";
import { RecurringBillsService } from "./recurring-bills.service";

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

describe("RecurringBillsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: RecurringBillsService; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      offset: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
    });
    const countWhere = jest.fn().mockResolvedValue([{ c: rows.length }]);
    let call = 0;
    const select = jest.fn().mockImplementation(() => {
      call++;
      if (call % 2 === 1) return { from: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) }) };
      return { from: jest.fn().mockReturnValue({ where: countWhere }) };
    });
    const db = { select } as unknown as Db;
    const audit = { log: jest.fn() } as never;
    const cache = { cachedForOrg: jest.fn().mockImplementation((_o: unknown, _k: unknown, fn: () => unknown) => fn()), invalidateForOrg: jest.fn() } as never;
    const dispatch = { emit: jest.fn() } as never;
    const svc = new RecurringBillsService(db, audit, cache, dispatch);
    return { svc, where };
  }

  it("scopes template list to the requesting org (tenant isolation)", async () => {
    const { svc, where } = makeService([]);

    await svc.listTemplates(ATTACKER_ORG, { page: 1, pageSize: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns templates for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.listTemplates(OWNER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
  });
});
