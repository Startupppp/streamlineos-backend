import { OrgHierarchyTreeSourceService } from "./org-hierarchy-tree-source.service";
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
    from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(), leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "orderBy", "leftJoin", "innerJoin", "groupBy"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

describe("OrgHierarchyTreeSourceService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(rows: unknown[]) {
    const { builder, where } = makeSelectChain(rows);
    const db = {
      select: jest.fn().mockReturnValue(builder),
      execute: jest.fn().mockResolvedValue([{ present: true }]),
      query: {
        hrmsMigrationProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
        orgUnitClosure: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new OrgHierarchyTreeSourceService(db);
    return { svc, where };
  }

  it("resolveReadProfile scopes query to the given org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    await svc.resolveReadProfile(ATTACKER);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
  });

  it("resolveReadProfile uses the owner org scope (control)", async () => {
    const { svc, where } = makeService([]);
    await svc.resolveReadProfile(OWNER);
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});
