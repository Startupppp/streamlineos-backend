import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";
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
    await svc.getStats(ScopedRead.of(ATTACKER, "user-attacker", "all"));
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("returns stats for the owning org (control)", async () => {
    const { svc, where } = makeService([{ cnt: 5, total: 10000 }]);
    const result = await svc.getStats(ScopedRead.of(OWNER, "user-owner", "all"));
    expect(result).toBeDefined();
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});

const dialect = new PgDialect();

function renderWhere(value: unknown): { sql: string; params: unknown[] } {
  if (!(value instanceof SQL)) throw new Error("expected a SQL WHERE clause");
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

describe("DealsAnalyticsService.getStats — the aggregate counts only rows the caller could list", () => {
  const ORG = "org-scope";
  const ME = "user-me";

  function makeService(rows: unknown[]) {
    const where = jest.fn();
    const builder = {
      from: jest.fn(),
      where,
      leftJoin: jest.fn(),
      innerJoin: jest.fn(),
      orderBy: jest.fn(),
      groupBy: jest.fn(),
      limit: jest.fn(),
      then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
      catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
      finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    };
    const select = jest.fn().mockReturnValue(builder);
    builder.from.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    builder.groupBy.mockReturnValue(builder);
    builder.limit.mockReturnValue(builder);
    where.mockReturnValue(builder);
    const db = { select } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: string, _k: string, fn: () => unknown) => fn()) };
    const crmMetadata = { getAggregate: jest.fn().mockResolvedValue({ stages: [] }) };
    const svc = new DealsAnalyticsService(db, cache as never, crmMetadata as never, {} as never);
    return { svc, where, select };
  }

  it("all scope: every aggregate WHERE carries the tenant predicate", async () => {
    const { svc, where } = makeService([{ cnt: 1, total: "10" }]);
    await svc.getStats(ScopedRead.of(ORG, ME, "all"));
    expect(where.mock.calls.length).toBeGreaterThan(0);
    for (const call of where.mock.calls) {
      const { sql, params } = renderWhere(call[0]);
      expect(sql).toContain("org_id");
      expect(params).toContain(ORG);
    }
  });

  it("all scope: no aggregate WHERE binds the actor — an unrestricted reader sees the whole org", async () => {
    const { svc, where } = makeService([{ cnt: 1, total: "10" }]);
    await svc.getStats(ScopedRead.of(ORG, ME, "all"));
    for (const call of where.mock.calls) {
      expect(renderWhere(call[0]).params).not.toContain(ME);
    }
  });

  it("own scope: every aggregate WHERE narrows on assigned_to_id and binds the caller", async () => {
    const { svc, where } = makeService([{ cnt: 1, total: "10" }]);
    await svc.getStats(ScopedRead.of(ORG, ME, "own"));
    expect(where.mock.calls.length).toBeGreaterThan(0);
    for (const call of where.mock.calls) {
      const { sql, params } = renderWhere(call[0]);
      expect(sql).toContain("assigned_to_id");
      expect(params).toContain(ME);
      expect(params).toContain(ORG);
    }
  });

  it("own scope renders a different aggregate WHERE from all scope — the count itself is narrowed, not filtered afterwards", async () => {
    const a = makeService([{ cnt: 1, total: "10" }]);
    await a.svc.getStats(ScopedRead.of(ORG, ME, "all"));
    const b = makeService([{ cnt: 1, total: "10" }]);
    await b.svc.getStats(ScopedRead.of(ORG, ME, "own"));
    expect(renderWhere(a.where.mock.calls[0]?.[0]).sql).not.toBe(
      renderWhere(b.where.mock.calls[0]?.[0]).sql,
    );
  });

  it("none scope: no query is issued at all and the totals are zero", async () => {
    const { svc, where, select } = makeService([{ cnt: 9, total: "900" }]);
    const result = await svc.getStats(ScopedRead.of(ORG, ME, "none"));
    expect(select).not.toHaveBeenCalled();
    expect(where).not.toHaveBeenCalled();
    expect(result).toEqual({ active: 0, pipelineValue: 0, wonValue: 0 });
  });
});
