import type { Db } from "../../../db/drizzle.module";
import { VendorPaymentsListService } from "./vendor-payments-list.service";

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

function makeItemsBuilder(rows: unknown[]): { builder: Record<string, jest.Mock>; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      offset: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
    }),
  });
  const leftJoin2 = jest.fn().mockReturnValue({ where });
  const leftJoin1 = jest.fn().mockReturnValue({ leftJoin: leftJoin2 });
  const from = jest.fn().mockReturnValue({ leftJoin: leftJoin1 });
  const builder = { from };
  return { builder: builder as Record<string, jest.Mock>, where };
}

function makeCountBuilder(count: number): Record<string, jest.Mock> {
  const where = jest.fn().mockResolvedValue([{ c: count }]);
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin });
  return { from } as Record<string, jest.Mock>;
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const { builder: itemsBuilder, where } = makeItemsBuilder(rows);
  const countBuilder = makeCountBuilder(rows.length);
  let call = 0;
  const select = jest.fn().mockImplementation(() => {
    call++;
    return call % 2 === 1 ? itemsBuilder : countBuilder;
  });
  const db = { select } as unknown as Db;
  return { db, where };
}

describe("VendorPaymentsListService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes the query to the requesting org (tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new VendorPaymentsListService(db);

    const result = await svc.list(ATTACKER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(0);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns rows for the owning org (same-tenant control)", async () => {
    const row = { id: 1, orgId: OWNER_ORG };
    const { db } = makeDb([row]);
    const svc = new VendorPaymentsListService(db);

    const result = await svc.list(OWNER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
  });
});
