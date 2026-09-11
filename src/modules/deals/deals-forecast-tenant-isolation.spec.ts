import type { Db } from "../../db/drizzle.module";
import { DealsForecastService } from "./deals-forecast.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

/** The learned-probability model, as theirs' analytics-scope spec doubles it. */
const forecastModel = {
  basisFor: (_orgId: string, readiness: unknown) =>
    Promise.resolve({ kind: "naive-weighted", reason: "not-trained-yet", readiness }),
  probabilitiesForOpenDeals: (_orgId: string) => Promise.resolve(new Map<number, number>()),
} as never;


describe("DealsForecastService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  /**
   * `buildForecast` makes two reads side by side: the open pipeline, which is
   * the caller's, and the closed history per terminal stage, which feeds only
   * `basis` and is deliberately the organisation's. Different scopes, one
   * tenant -- so the org predicate is asserted on both, and the second read
   * ends in `.groupBy()` because it counts per stage.
   */
  function makeService(dealsRows: unknown[], closedRows: unknown[] = []) {
    let capturedForecastWhere: unknown;
    let capturedClosedWhere: unknown;

    const dealsLimit = jest.fn().mockResolvedValue(dealsRows);
    const dealsWhere = jest.fn().mockImplementation((pred: unknown) => {
      capturedForecastWhere = pred;
      return { limit: dealsLimit };
    });
    const dealsFrom = jest.fn().mockReturnValue({ where: dealsWhere });

    const closedLimit = jest.fn().mockResolvedValue(closedRows);
    const closedGroupBy = jest.fn().mockReturnValue({ limit: closedLimit });
    const closedWhere = jest.fn().mockImplementation((pred: unknown) => {
      capturedClosedWhere = pred;
      return { groupBy: closedGroupBy };
    });
    const closedFrom = jest.fn().mockReturnValue({ where: closedWhere });

    const db = {
      select: jest.fn().mockImplementationOnce(() => ({ from: dealsFrom })).mockImplementationOnce(() => ({ from: closedFrom })),
    } as unknown as Db;

    const cache = {
      cached: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
      cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()),
    };

    const crmMetadata = {
      getAggregate: jest.fn().mockResolvedValue({ stages: [] }),
    };

    const svc = new DealsForecastService(db, cache as never, crmMetadata as never, forecastModel);
    return {
      svc,
      getForecastWhere: () => capturedForecastWhere,
      getClosedWhere: () => capturedClosedWhere,
    };
  }

  it("DENY: getForecast queries only the requesting org's deals (cross-tenant isolation)", async () => {
    const { svc, getForecastWhere, getClosedWhere } = makeService([]);

    const result = await svc.getForecast(ATTACKER_ORG, { scope: "all", userId: "user-1" });

    expect(result.totalDeals).toBe(0);
    for (const where of [getForecastWhere(), getClosedWhere()]) {
      const vals = sqlValues(where);
      expect(vals).toContain(ATTACKER_ORG);
      expect(vals).not.toContain(OWNER_ORG);
    }
  });

  it("CONTROL: getForecast scopes the query to the owner org", async () => {
    const { svc, getForecastWhere, getClosedWhere } = makeService([]);

    await svc.getForecast(OWNER_ORG, { scope: "all", userId: "user-1" });

    expect(sqlValues(getForecastWhere())).toContain(OWNER_ORG);
    expect(sqlValues(getClosedWhere())).toContain(OWNER_ORG);
  });

  it("DENY: getForecastSnapshots queries only the requesting org's snapshots (cross-tenant isolation)", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    let capturedWhere: unknown;
    const where = jest.fn().mockImplementation((pred: unknown) => {
      capturedWhere = pred;
      return { orderBy };
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()) };
    const crmMetadata = { getAggregate: jest.fn().mockResolvedValue({ stages: [] }) };
    const svc = new DealsForecastService(db, cache as never, crmMetadata as never, forecastModel);

    const result = await svc.getForecastSnapshots(ATTACKER_ORG, { limit: 20 });

    expect(result.snapshots).toHaveLength(0);
    const vals = sqlValues(capturedWhere);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });
});
