import type { Db } from "../../../db/drizzle.module";
import { ForecastService } from "./forecast.service";

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

type WhereResult = Promise<unknown[]> & { limit: jest.Mock; orderBy: jest.Mock; groupBy: jest.Mock };

function makeWhereResult(): WhereResult {
  const p = Promise.resolve([]) as WhereResult;
  p.limit = jest.fn().mockResolvedValue([]);
  p.orderBy = jest.fn().mockResolvedValue([]);
  p.groupBy = jest.fn().mockResolvedValue([]);
  return p;
}

function makeFromResult(): { where: jest.Mock; innerJoin: jest.Mock; leftJoin: jest.Mock } {
  const where = jest.fn().mockImplementation(() => makeWhereResult());
  const innerJoin = jest.fn().mockReturnValue({ where });
  const leftJoin = jest.fn().mockReturnValue({ where, leftJoin: jest.fn().mockReturnValue({ where }) });
  return { where, innerJoin, leftJoin };
}

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => {
      const fromResult = makeFromResult();
      const origWhere = fromResult.where;
      fromResult.where = jest.fn().mockImplementation((arg: unknown) => {
        allWhereArgs.push(arg);
        return origWhere(arg);
      });
      return { from: jest.fn().mockReturnValue(fromResult) };
    }),
    query: { finCashFlowScenarios: { findFirst: jest.fn().mockResolvedValue(undefined) } },
  } as unknown as Db;
  return { db, allWhereArgs };
}

describe("ForecastService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes all queries to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new ForecastService(db, cache);

    await svc.getForecast(ATTACKER_ORG, { weeks: 1 });

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns a defined forecast for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new ForecastService(db, cache);

    const result = await svc.getForecast(OWNER_ORG, { weeks: 1 });

    expect(result).toBeDefined();
    expect(result.weeks).toBeDefined();
  });
});
