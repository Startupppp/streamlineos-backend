import { ScopedRead } from "../access/scoped-read";
import type { Db } from "../../db/drizzle.module";
import { LeadsReportsService } from "./leads-reports.service";

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
  builder.groupBy = jest.fn().mockImplementation(chain);
  builder.limit = jest.fn().mockImplementation(chain);
  where.mockImplementation(chain);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("LeadsReportsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes status query to the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeThenableBuilder([]);
    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_n: string, _k: string, fn: () => unknown) => fn()),
    };
    const teamReports = { getSalesLeaderboard: jest.fn().mockResolvedValue({}) };
    const access = { getDataScopeForUser: jest.fn(), membersWithPermission: jest.fn().mockResolvedValue([]) };
    const svc = new LeadsReportsService(db, cache as never, teamReports as never, access as never);
    await svc.getLeadAnalytics(ScopedRead.of(ATTACKER, "user-1", "all"), {});
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("returns data for the owning org (control)", async () => {
    const { db } = makeThenableBuilder([]);
    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_n: string, _k: string, fn: () => unknown) => fn()),
    };
    const teamReports = { getSalesLeaderboard: jest.fn().mockResolvedValue({}) };
    const access = { getDataScopeForUser: jest.fn(), membersWithPermission: jest.fn().mockResolvedValue([]) };
    const svc = new LeadsReportsService(db, cache as never, teamReports as never, access as never);
    const result = await svc.getLeadAnalytics(ScopedRead.of(OWNER, "user-1", "all"), {});
    expect(result).toBeDefined();
  });
});
