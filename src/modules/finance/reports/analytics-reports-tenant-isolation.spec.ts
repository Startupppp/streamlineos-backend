import type { Db } from "../../../db/drizzle.module";
import { journalLines, orgUnits, projects } from "../../../db/schema";
import { AnalyticsReportsService } from "./analytics-reports.service";
import { computeDeptProfitability, computeProjectProfitability } from "./lib/profitability-reports";

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

type ChainResult = Promise<unknown[]> & {
  limit: jest.Mock;
  orderBy: jest.Mock;
  groupBy: jest.Mock;
  offset: jest.Mock;
};

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

/**
 * Remembers which table each WHERE belongs to. The aggregate reads bind the org
 * id as well, so an assertion over every WHERE at once stays green with a
 * hydration read's org predicate deleted; these tests pick the read by table.
 */
function makeTableAwareDb(rowsByTable: Map<unknown, unknown[]>) {
  const reads: { table: unknown; where: unknown }[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => {
      let table: unknown;
      const builder: { from: jest.Mock; innerJoin: jest.Mock; where: jest.Mock } = {
        from: jest.fn(),
        innerJoin: jest.fn(),
        where: jest.fn(),
      };
      builder.from.mockImplementation((t: unknown) => {
        table = t;
        return builder;
      });
      builder.innerJoin.mockReturnValue(builder);
      builder.where.mockImplementation((arg: unknown) => {
        reads.push({ table, where: arg });
        const rows = rowsByTable.get(table) ?? [];
        return Object.assign(Promise.resolve(rows), { groupBy: jest.fn().mockResolvedValue(rows) });
      });
      return builder;
    }),
  } as unknown as Db;
  const whereOn = (table: unknown) => reads.filter((r) => r.table === table).map((r) => r.where);
  return { db, whereOn };
}

describe("profitability id-to-name hydration — tenant predicate", () => {
  const ORG = "org-caller";

  it("re-asserts the caller's org on the projects lookup, not only on the aggregates", async () => {
    const { db, whereOn } = makeTableAwareDb(
      new Map<unknown, unknown[]>([
        [
          journalLines,
          [
            { projectId: 7, totalCredit: "500.00", totalDebit: "0" },
            { projectId: 9, totalCredit: "0", totalDebit: "120.00" },
          ],
        ],
        [projects, [{ id: 7, name: "Apollo" }, { id: 9, name: "Gemini" }]],
      ]),
    );

    const rows = await computeProjectProfitability({ db }, ORG, "2024-01-01", "2024-12-31");

    expect(whereOn(projects)).toHaveLength(1);
    expect(sqlValues(whereOn(projects)[0])).toEqual(expect.arrayContaining([ORG, 7, 9]));
    expect(rows.map((r) => r.projectName)).toEqual(["Apollo", "Gemini"]);
  });

  it("re-asserts the caller's org on the org_units lookup, not only on the aggregates", async () => {
    const { db, whereOn } = makeTableAwareDb(
      new Map<unknown, unknown[]>([
        [journalLines, [{ departmentId: "dept-1", totalCredit: "300.00", totalDebit: "0" }]],
        [orgUnits, [{ id: "dept-1", name: "Field Ops" }]],
      ]),
    );

    const rows = await computeDeptProfitability({ db }, ORG, "2024-01-01", "2024-12-31");

    expect(whereOn(orgUnits)).toHaveLength(1);
    expect(sqlValues(whereOn(orgUnits)[0])).toEqual(expect.arrayContaining([ORG, "dept-1"]));
    expect(rows.map((r) => r.departmentName)).toEqual(["Field Ops"]);
  });
});
