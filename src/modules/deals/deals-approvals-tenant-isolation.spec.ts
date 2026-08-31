import type { Db } from "../../db/drizzle.module";
import { DealsApprovalsService } from "./deals-approvals.service";

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
  builder.orderBy = jest.fn().mockImplementation(chain);
  builder.limit = jest.fn().mockImplementation(chain);
  where.mockImplementation(chain);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("DealsApprovalsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns no rules for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeThenableBuilder([]);
    const cache = { invalidate: jest.fn(), cachedVersioned: jest.fn() };
    const notifications = { send: jest.fn() };
    const svc = new DealsApprovalsService(db, cache as never, notifications as never);
    const result = await svc.listRules(ATTACKER);
    expect(result).toHaveLength(0);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns rules for the owning org (control)", async () => {
    const { db, where } = makeThenableBuilder([{ id: 1, orgId: OWNER, minValue: 1000 }]);
    const cache = { invalidate: jest.fn(), cachedVersioned: jest.fn() };
    const notifications = { send: jest.fn() };
    const svc = new DealsApprovalsService(db, cache as never, notifications as never);
    const result = await svc.listRules(OWNER);
    expect(result).toHaveLength(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
