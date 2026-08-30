import type { Db } from "../../../db/drizzle.module";
import { ArPaymentsService } from "./ar-payments.service";

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

function makeItemsChain(rows: unknown[]): { chain: Record<string, jest.Mock>; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(rows) }),
    }),
  });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const innerJoin = jest.fn().mockReturnValue({ leftJoin });
  const chain = { from: jest.fn().mockReturnValue({ innerJoin }) };
  return { chain, where };
}

function makeCountChain(n: number): Record<string, jest.Mock> {
  const where = jest.fn().mockResolvedValue([{ count: n }]);
  const innerJoin = jest.fn().mockReturnValue({ where });
  return { from: jest.fn().mockReturnValue({ innerJoin }) };
}

function makeSimpleChain(rows: unknown[]): Record<string, jest.Mock> {
  const where = jest.fn().mockResolvedValue(rows);
  return { from: jest.fn().mockReturnValue({ where }) };
}

describe("ArPaymentsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes the list query to the requesting org (tenant isolation)", async () => {
    const { chain, where } = makeItemsChain([]);
    const countChain = makeCountChain(0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        return call % 2 === 1 ? chain : countChain;
      }),
    } as unknown as Db;
    const svc = new ArPaymentsService(db);

    const result = await svc.list(ATTACKER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(0);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns rows for the owning org (same-tenant control)", async () => {
    const row = { id: 1, orgId: OWNER_ORG };
    const { chain } = makeItemsChain([row]);
    const countChain = makeCountChain(1);
    const allocChain = makeSimpleChain([]);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return chain;
        if (call === 2) return countChain;
        return allocChain;
      }),
    } as unknown as Db;
    const svc = new ArPaymentsService(db);

    const result = await svc.list(OWNER_ORG, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
  });
});
