import type { Db } from "../../../db/drizzle.module";
import { TaxCodesService } from "./tax-codes.service";

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

describe("TaxCodesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(items: unknown[]): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => {
        const where = jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return {
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(items),
            }),
          };
        });
        return { from: jest.fn().mockReturnValue({ where }) };
      }),
    } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes list to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb([]);
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new TaxCodesService(db, cache, {} as never, {} as never);

    await svc.list(ATTACKER_ORG, { limit: 10 });

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns tax codes for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG }]);
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new TaxCodesService(db, cache, {} as never, {} as never);

    const result = await svc.list(OWNER_ORG, { limit: 10 });

    expect(result.data).toHaveLength(1);
  });
});
