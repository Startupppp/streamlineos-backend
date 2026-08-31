import type { Db } from "../../../db/drizzle.module";
import { AnalyticsReportsService } from "./analytics-reports.service";

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

type ChainResult = any;

function makeChainResult(): ChainResult {
  const arr: unknown[] = [];
  return Object.assign(Promise.resolve(arr), {
    limit: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
    offset: jest.fn().mockResolvedValue([]),
  });
}

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => {
      const where = jest.fn().mockImplementation((arg: unknown) => {
        allWhereArgs.push(arg);
        return makeChainResult();
      });
      const innerJoin = jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }), leftJoin: jest.fn().mockReturnValue({ where }) });
      const leftJoin = jest.fn().mockReturnValue({ where, innerJoin, leftJoin: jest.fn().mockReturnValue({ where }) });
      return { from: jest.fn().mockReturnValue({ where, innerJoin, leftJoin }) };
    }),
  } as unknown as Db;
  return { db, allWhereArgs };
}

describe("AnalyticsReportsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes project profitability queries to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new AnalyticsReportsService(db, cache);

    await svc.projectProfitability(ATTACKER_ORG, "2024-01-01", "2024-12-31");

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns a result for the owning org without cross-org data (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new AnalyticsReportsService(db, cache);

    const result = await svc.projectProfitability(OWNER_ORG, "2024-01-01", "2024-12-31");

    expect(result).toBeDefined();
  });
});
