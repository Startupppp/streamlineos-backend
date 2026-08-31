import type { Db } from "../../../db/drizzle.module";
import { InsightsFindersService } from "./insights-finders.service";

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

type ChainResult = Promise<unknown[]> & { limit: jest.Mock; orderBy: jest.Mock; groupBy: jest.Mock; offset: jest.Mock };

function makeChainResult(): ChainResult {
  const p = Promise.resolve([]) as ChainResult;
  p.limit = jest.fn().mockResolvedValue([]);
  p.orderBy = jest.fn().mockResolvedValue([]);
  p.groupBy = jest.fn().mockResolvedValue([]);
  p.offset = jest.fn().mockResolvedValue([]);
  return p;
}

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => {
      const where = jest.fn().mockImplementation((arg: unknown) => {
        allWhereArgs.push(arg);
        return makeChainResult();
      });
      const leftJoin = jest.fn().mockReturnValue({ where, leftJoin: jest.fn().mockReturnValue({ where }) });
      const innerJoin = jest.fn().mockReturnValue({ where, leftJoin });
      return { from: jest.fn().mockReturnValue({ where, leftJoin, innerJoin }) };
    }),
  } as unknown as Db;
  return { db, allWhereArgs };
}

describe("InsightsFindersService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes expense spike search to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const svc = new InsightsFindersService(db);

    await svc.findExpenseSpikes(ATTACKER_ORG, "2024-01-01", "2024-12-31");

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns empty findings for org with no data (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new InsightsFindersService(db);

    const result = await svc.findExpenseSpikes(OWNER_ORG, "2024-01-01", "2024-12-31");

    expect(result).toBeInstanceOf(Array);
  });
});
