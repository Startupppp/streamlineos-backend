import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeSelectChain(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(), leftJoin: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "orderBy", "leftJoin"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

describe("OrgHierarchyTeamsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const TEAM = { id: "t1", orgId: OWNER, name: "Backend Team", kind: "TEAM", status: "ACTIVE", parentId: null, headUserId: null, code: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null };

  function makeService(rows: unknown[]) {
    const { builder, where } = makeSelectChain(rows);
    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn(), invalidateForOrg: jest.fn() };
    const audit = { log: jest.fn() };
    const svc = new OrgHierarchyTeamsService(db, cache as never, audit as never);
    return { svc, where };
  }

  it("listTeams returns empty for a different org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.listTeams(ATTACKER, { limit: 25 });
    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
  });

  it("listTeams returns rows for the owning org (control)", async () => {
    const { svc } = makeService([TEAM]);
    const result = await svc.listTeams(OWNER, { limit: 25 });
    expect(result.data.length).toBeGreaterThan(0);
  });
});
