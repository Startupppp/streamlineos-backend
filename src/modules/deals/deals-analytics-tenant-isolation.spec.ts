import type { Db } from "../../db/drizzle.module";
import { DealsAnalyticsService } from "./deals-analytics.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("DealsAnalyticsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(rows: unknown[]) {
    const where = jest.fn().mockResolvedValue(rows);
    const builder = {
      from: jest.fn(),
      where,
      leftJoin: jest.fn(),
      innerJoin: jest.fn(),
      orderBy: jest.fn(),
      groupBy: jest.fn(),
      limit: jest.fn(),
    };
    builder.from.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    builder.groupBy.mockReturnValue(builder);
    builder.limit.mockReturnValue(builder);
    where.mockReturnValue(builder);
    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: string, _k: string, fn: () => unknown) => fn()) };
    const crmMetadata = { getAggregate: jest.fn().mockResolvedValue({ stages: [] }) };
    const svc = new DealsAnalyticsService(db, cache as never, crmMetadata as never, {} as never);
    return { svc, where };
  }

  it("scopes stats query to the requesting org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([{ cnt: 0, total: null }]);
    await svc.getStats(ATTACKER);
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("returns stats for the owning org (control)", async () => {
    const { svc, where } = makeService([{ cnt: 5, total: 10000 }]);
    const result = await svc.getStats(OWNER);
    expect(result).toBeDefined();
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});
