import type { Db } from "../../db/drizzle.module";
import { LeadStatusService } from "./lead-status.service";

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
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("LeadStatusService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(rows: unknown[]) {
    const { db: baseDb, where } = makeThenableBuilder(rows);
    const db = { ...baseDb, transaction: jest.fn().mockResolvedValue(undefined) } as unknown as Db;
    const cache = { invalidate: jest.fn(), cachedVersioned: jest.fn() };
    const audit = { log: jest.fn() };
    const crmMetadata = { getAggregate: jest.fn().mockResolvedValue({ options: [], stages: [] }) };
    const blueprints = { assertTransitionAllowed: jest.fn().mockResolvedValue({ allowed: true }) };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const conversion = { convert: jest.fn() };
    const svc = new LeadStatusService(db, cache as never, audit as never, crmMetadata as never, blueprints as never, planLimits as never, conversion as never);
    return { svc, where };
  }

  it("returns stale_or_missing for a different org lead (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.transitionLeadStatus(ATTACKER, "u1", 99, { status: "contacted" });
    expect(result).toEqual({ ok: false, reason: "stale_or_missing" });
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("queries with the correct org for the owning org (control)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.transitionLeadStatus(OWNER, "u1", 99, { status: "contacted" });
    expect(result).toEqual({ ok: false, reason: "stale_or_missing" });
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});
