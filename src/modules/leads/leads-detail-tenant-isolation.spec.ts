import type { Db } from "../../db/drizzle.module";
import { LeadsDetailService } from "./leads-detail.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("LeadsDetailService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(rows: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const db = {
      query: {
        leadActivities: { findMany },
        leadNotes: { findMany: jest.fn().mockResolvedValue([]) },
        leadTasks: { findMany: jest.fn().mockResolvedValue([]) },
        leadScoringRules: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
      }),
    } as unknown as Db;
    const svc = new LeadsDetailService(
      db,
      { log: jest.fn() } as never,
      { emit: jest.fn() } as never,
      { send: jest.fn() } as never,
      { enrichLead: jest.fn() } as never,
    );
    return { svc, findMany };
  }

  it("returns no activities for a different org (cross-tenant isolation)", async () => {
    const { svc, findMany } = makeService([]);
    const result = await svc.getActivities(ATTACKER, 1, 10);
    expect(result).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns activities for the owning org (control)", async () => {
    const { svc, findMany } = makeService([{ id: 1, orgId: OWNER, leadId: 1 }]);
    const result = await svc.getActivities(OWNER, 1, 10);
    expect(result).toHaveLength(1);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(OWNER);
  });
});
