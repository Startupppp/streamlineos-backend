import { type Db } from "../../../db/drizzle.module";
import { HrAttendanceAnalyticsService } from "./hr-attendance-analytics.service";
import { CacheService } from "../../../common/cache/cache.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeSelectChain(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(),
    innerJoin: jest.fn(), leftJoin: jest.fn(), groupBy: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin", "groupBy"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

function makeService(rows: unknown[]) {
  const { builder, where } = makeSelectChain(rows);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  const cache = {
    cachedVersionedForOrg: jest.fn().mockImplementation(
      (_orgId: string, _ns: string, _key: string, factory: () => unknown) => factory(),
    ),
  } as unknown as CacheService;
  const svc = new HrAttendanceAnalyticsService(db, cache);
  return { svc, where };
}

describe("HrAttendanceAnalyticsService — cross-tenant isolation", () => {
  it("attrition scopes every query to the caller's org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([{ count: 0 }]);

    await svc.attrition(ATTACKER_ORG);

    expect(where).toHaveBeenCalled();
    for (const call of where.mock.calls) {
      const vals = sqlValues(call[0]);
      expect(vals).toContain(ATTACKER_ORG);
    }
  });

  it("attrition returns zero counts for an org with no data (no cross-tenant leakage)", async () => {
    const { svc } = makeService([]);

    const result = await svc.attrition(ATTACKER_ORG);

    expect(result).toMatchObject({ totalEmployees: 0, resignedThisYear: 0 });
  });

  it("attrition does not include the owning org's orgId when called for the attacker org (isolation boundary)", async () => {
    const { svc, where } = makeService([{ count: 0 }]);

    await svc.attrition(ATTACKER_ORG);

    for (const call of where.mock.calls) {
      const vals = sqlValues(call[0]);
      expect(vals).not.toContain(OWNER_ORG);
    }
  });
});
