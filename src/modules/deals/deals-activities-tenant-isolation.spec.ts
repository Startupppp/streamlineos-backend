import { NotFoundException } from "@nestjs/common";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";
import { DealsActivitiesService } from "./deals-activities.service";
import { DealsAnalyticsService } from "./deals-analytics.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeThenableBuilder(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  const chain = () => builder;
  builder.from = jest.fn().mockImplementation(chain);
  builder.where = where;
  builder.leftJoin = jest.fn().mockImplementation(chain);
  builder.innerJoin = jest.fn().mockImplementation(chain);
  builder.orderBy = jest.fn().mockImplementation(chain);
  builder.limit = jest.fn().mockImplementation(chain);
  where.mockImplementation(chain);
  const findFirst = jest.fn().mockResolvedValue({ id: 1, updatedAt: new Date(), activities: [] });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: { deals: { findFirst } },
  } as unknown as Db;
  return { db, where, findFirst };
}

describe("DealsActivitiesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns no stage transitions for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeThenableBuilder([]);
    const activities = { list: jest.fn().mockResolvedValue([]) };
    const svc = new DealsActivitiesService(db, activities as never);
    const result = await svc.listStageTransitions(ScopedRead.of(ATTACKER, "user-attacker", "all"), 1);
    expect(result).toHaveLength(0);
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("returns stage transitions for the owning org (control)", async () => {
    const { db, where } = makeThenableBuilder([{ dealStageTransitionId: 1, fromStage: "a", toStage: "b" }]);
    const activities = { list: jest.fn().mockResolvedValue([]) };
    const svc = new DealsActivitiesService(db, activities as never);
    const result = await svc.listStageTransitions(ScopedRead.of(OWNER, "user-owner", "all"), 1);
    expect(result).toHaveLength(1);
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});

const dialect = new PgDialect();
const ORG = "org-scope";
const ME = "user-me";
const DEAL_ID = 88;

function renderWhere(value: unknown): { sql: string; params: unknown[] } {
  if (!(value instanceof SQL)) throw new Error("expected a SQL WHERE clause");
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

type Harness = ReturnType<typeof makeThenableBuilder>;
type Invoke = (h: Harness, read: ScopedRead) => Promise<unknown>;

function analytics(h: Harness): DealsAnalyticsService {
  const cache = { cached: jest.fn(), cachedVersioned: jest.fn() };
  const crmMetadata = { getAggregate: jest.fn().mockResolvedValue({ stages: [] }) };
  return new DealsAnalyticsService(h.db, cache as never, crmMetadata as never, {} as never);
}

const CASES: ReadonlyArray<{ name: string; run: Invoke }> = [
  {
    name: "DealsActivitiesService.listStageTransitions",
    run: (h, read) => new DealsActivitiesService(h.db, { list: jest.fn() } as never).listStageTransitions(read, DEAL_ID),
  },
  {
    name: "DealsActivitiesService.listActivities",
    run: (h, read) =>
      new DealsActivitiesService(h.db, { timeline: jest.fn().mockResolvedValue({ data: [] }) } as never).listActivities(read, DEAL_ID),
  },
  {
    name: "DealsAnalyticsService.getDealHealth",
    run: (h, read) => analytics(h).getDealHealth(read, DEAL_ID),
  },
];

describe("deal child surfaces spend the DataScope on the parent deal", () => {
  it("enumerates every method under test — an empty table cannot pass vacuously", () => {
    expect(CASES).toHaveLength(3);
  });

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — own scope narrows the parent read on assigned_to_id and binds the caller",
    async (_name, run) => {
      const h = makeThenableBuilder([]);
      await run(h, ScopedRead.of(ORG, ME, "own")).catch(() => undefined);
      expect(h.findFirst).toHaveBeenCalled();
      const { sql, params } = renderWhere(h.findFirst.mock.calls[0]?.[0]?.where);
      expect(sql).toContain("assigned_to_id");
      expect(sql).toContain("org_id");
      expect(params).toContain(ME);
      expect(params).toContain(ORG);
      expect(params).toContain(DEAL_ID);
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — all scope keeps the tenant predicate without binding the actor",
    async (_name, run) => {
      const h = makeThenableBuilder([]);
      await run(h, ScopedRead.of(ORG, ME, "all")).catch(() => undefined);
      expect(h.findFirst).toHaveBeenCalled();
      const { sql, params } = renderWhere(h.findFirst.mock.calls[0]?.[0]?.where);
      expect(sql).toContain("org_id");
      expect(params).toContain(ORG);
      expect(params).not.toContain(ME);
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — none scope issues no query at all and 404s",
    async (_name, run) => {
      const h = makeThenableBuilder([]);
      await expect(run(h, ScopedRead.of(ORG, ME, "none"))).rejects.toThrow(NotFoundException);
      expect(h.findFirst).not.toHaveBeenCalled();
      expect(h.where).not.toHaveBeenCalled();
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — a deal the predicate excludes is a 404, never a 403",
    async (_name, run) => {
      const h = makeThenableBuilder([]);
      h.findFirst.mockResolvedValue(undefined);
      await expect(run(h, ScopedRead.of(ORG, ME, "own"))).rejects.toThrow(NotFoundException);
    },
  );
});
