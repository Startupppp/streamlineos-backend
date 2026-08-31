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

describe("DealsForecastService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeService(dealsRows: unknown[], snapshotRows: unknown[] = []) {
    let capturedForecastWhere: unknown;
    let capturedSnapshotWhere: unknown;

    const dealsLimit = jest.fn().mockResolvedValue(dealsRows);
    const dealsWhere = jest.fn().mockImplementation((pred: unknown) => {
      capturedForecastWhere = pred;
      return { limit: dealsLimit };
    });
    const dealsFrom = jest.fn().mockReturnValue({ where: dealsWhere });

    const snapshotLimit = jest.fn().mockResolvedValue(snapshotRows);
    const snapshotOrderBy = jest.fn().mockReturnValue({ limit: snapshotLimit });
    const snapshotWhere = jest.fn().mockImplementation((pred: unknown) => {
      capturedSnapshotWhere = pred;
      return { orderBy: snapshotOrderBy };
    });
    const snapshotFrom = jest.fn().mockReturnValue({ where: snapshotWhere });

    const db = {
      select: jest.fn().mockImplementationOnce(() => ({ from: dealsFrom })).mockImplementationOnce(() => ({ from: snapshotFrom })),
    } as unknown as Db;

    const cache = {
      cached: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
      cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, fn: () => unknown) => fn()),
    };

    const crmMetadata = {
      getAggregate: jest.fn().mockResolvedValue({ stages: [] }),
    };

    const svc = new DealsForecastService(db, cache as never, crmMetadata as never);
    return {
      svc,
      getForecastWhere: () => capturedForecastWhere,
      getSnapshotWhere: () => capturedSnapshotWhere,
    };
  }

  it("DENY: getForecast queries only the requesting org's deals (cross-tenant isolation)", async () => {
    const { svc, getForecastWhere } = makeService([]);

    const result = await svc.getForecast(ATTACKER_ORG);

    expect(result.totalDeals).toBe(0);
    const vals = sqlValues(getForecastWhere());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });

  it("CONTROL: getForecast scopes the query to the owner org", async () => {
    const { svc, getForecastWhere } = makeService([]);

    await svc.getForecast(OWNER_ORG);

    expect(sqlValues(getForecastWhere())).toContain(OWNER_ORG);
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
    const svc = new DealsForecastService(db, cache as never, crmMetadata as never);

    const result = await svc.getForecastSnapshots(ATTACKER_ORG, { limit: 20 });

    expect(result.snapshots).toHaveLength(0);
    const vals = sqlValues(capturedWhere);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });
});
