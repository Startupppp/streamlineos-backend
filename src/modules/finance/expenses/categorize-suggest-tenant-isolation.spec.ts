import type { Db } from "../../../db/drizzle.module";
import { CategorizeSuggestService } from "./categorize-suggest.service";

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

type ChainResult = Promise<unknown[]> & { limit: jest.Mock; orderBy: jest.Mock; groupBy: jest.Mock };

function makeChainResult(rows: unknown[] = []): ChainResult {
  const p = Promise.resolve(rows) as ChainResult;
  p.limit = jest.fn().mockResolvedValue(rows);
  p.orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });
  p.groupBy = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }) });
  return p;
}

describe("CategorizeSuggestService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => {
        const where = jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeChainResult(rows);
        });
        const leftJoin = jest.fn().mockReturnValue({ where });
        return { from: jest.fn().mockReturnValue({ leftJoin, where }) };
      }),
    } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes category suggestion queries to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb([]);
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new CategorizeSuggestService(db, cache);

    await svc.suggest(ATTACKER_ORG, { merchant: "Test Store" });

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns a suggestion result for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ categoryId: 5, categoryName: "Travel", cnt: "10" }]);
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new CategorizeSuggestService(db, cache);

    const result = await svc.suggest(OWNER_ORG, { merchant: "Airline" });

    expect(result).toBeDefined();
    expect(result.basis).toBeDefined();
  });
});
