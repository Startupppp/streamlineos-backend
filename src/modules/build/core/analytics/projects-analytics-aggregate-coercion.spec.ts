import type { Db } from "../../../../db/drizzle.types";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { CacheService } from "../../../../common/cache/cache.service";

function passThroughCache() {
  return {
    cachedVersioned: <T>(_namespace: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;
}


type Selection = Record<string, unknown>;

interface Decodable {
  readonly decoder?: { mapFromDriverValue(value: unknown): unknown };
}

function captureSelections(): { db: Db; selections: Selection[] } {
  const selections: Selection[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"])
    chain[method] = jest.fn(() => chain);
  chain["then"] = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);

  const db = {
    select: jest.fn((selection: Selection) => {
      selections.push(selection);
      return chain;
    }),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projects: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1" }),
      },
      users: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;

  return { db, selections };
}

function decode(field: unknown, driverValue: string): unknown {
  const decoder = (field as Decodable).decoder;
  if (!decoder) return driverValue;
  return decoder.mapFromDriverValue(driverValue);
}

function fieldsNamed(selections: Selection[], name: string): unknown[] {
  return selections.filter((s) => name in s).map((s) => s[name]);
}

describe("ProjectsAnalyticsService aggregate coercion", () => {
  it("decodes cycleVelocity completedPoints to a number, because SUM over the integer points column arrives from postgres-js as a bigint string and the frontend contract types it z.number()", async () => {
    const { db, selections } = captureSelections();

    await new ProjectsAnalyticsService(db, passThroughCache()).getProjectAnalytics("org-1", 1);

    const fields = fieldsNamed(selections, "completedPoints");
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(decode(field, "40")).toBe(40);
  });

  it("decodes estimateVsActual actual to a number, because SUM over the decimal hours column arrives as a numeric string and fractional hours must survive", async () => {
    const { db, selections } = captureSelections();

    await new ProjectsAnalyticsService(db, passThroughCache()).getProjectAnalytics("org-1", 1);

    const fields = fieldsNamed(selections, "actual");
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(decode(field, "12.50")).toBe(12.5);
  });

  it("coerces the single-row org health aggregate without fetching project rows", async () => {
    const { db, selections } = captureSelections();
    (db.execute as jest.Mock).mockResolvedValueOnce([{ total: "2", healthy: "1", atRisk: "1", critical: "0", avgScore: "55" }]);

    await expect(new ProjectsAnalyticsService(db, passThroughCache()).getOrgProjectHealthSummary("org-1")).resolves.toEqual({
      total: 2,
      healthy: 1,
      atRisk: 1,
      critical: 0,
      avgScore: 55,
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(selections).toHaveLength(0);
  });

  it("leaves a raw string unconverted when no decoder is attached, proving these assertions can fail", () => {
    expect(decode({}, "40")).toBe("40");
  });
});
