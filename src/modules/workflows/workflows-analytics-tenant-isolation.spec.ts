import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WorkflowsAnalyticsService } from "./workflows-analytics.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

function makeDb(rows: unknown[] = []) {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    innerJoin: jest.fn(),
  };
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("WorkflowsAnalyticsService — cross-tenant isolation", () => {
  it("getAnalytics: where predicate carries the attacker orgId (deny — queries are tenant-scoped)", async () => {
    const { db, where } = makeDb([{ total: 0, active: 0 }]);
    const svc = new WorkflowsAnalyticsService(db);
    const result = await svc.getAnalytics(ATTACKER);
    expect(result.totalWorkflows).toBe(0);
    expect(where).toHaveBeenCalled();
    const passedValues = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(passedValues).toContain(ATTACKER);
    expect(passedValues).not.toContain(OWNER);
  });

  it("getAnalytics: where predicate carries the owner orgId and returns data (control)", async () => {
    const { db, where } = makeDb([{ total: 3, active: 2 }]);
    const svc = new WorkflowsAnalyticsService(db);
    const result = await svc.getAnalytics(OWNER);
    expect(result.totalWorkflows).toBe(3);
    const passedValues = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(passedValues).toContain(OWNER);
  });
});
