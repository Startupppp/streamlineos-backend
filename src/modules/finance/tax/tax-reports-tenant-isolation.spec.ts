import type { Db } from "../../../db/drizzle.module";
import { TaxReportsService } from "./tax-reports.service";

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

function makeChain(rows: unknown[]): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    offset: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    groupBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeFrom(rows: unknown[], allWhereArgs: unknown[]): object {
  const where = jest.fn().mockImplementation((arg: unknown) => {
    allWhereArgs.push(arg);
    return makeChain(rows);
  });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(rows, allWhereArgs));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(rows, allWhereArgs));
  return self;
}

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  let selectCall = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCall++;
      const isCountQuery = selectCall % 2 === 0;
      const rows = isCountQuery ? [{ total: 0 }] : [];
      return { from: jest.fn().mockImplementation(() => makeFrom(rows, allWhereArgs)) };
    }),
  } as unknown as Db;
  return { db, allWhereArgs };
}

describe("TaxReportsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes output report queries to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const posting = {} as never;
    const svc = new TaxReportsService(db, cache, posting);

    await svc.getOutputReport(ATTACKER_ORG, { from: "2024-01-01", to: "2024-12-31", limit: 50, format: "json" as const });

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns a defined report for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const posting = {} as never;
    const svc = new TaxReportsService(db, cache, posting);

    const result = await svc.getOutputReport(OWNER_ORG, { from: "2024-01-01", to: "2024-12-31", limit: 50, format: "json" as const });

    expect(result).toBeDefined();
  });
});
