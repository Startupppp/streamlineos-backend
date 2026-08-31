import { OrgHierarchyReadService } from "./org-hierarchy-read.service";
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
    from: jest.fn(), where, groupBy: jest.fn(), limit: jest.fn(), orderBy: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "groupBy", "limit", "orderBy"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

describe("OrgHierarchyReadService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(countRows: unknown[]) {
    const { builder, where } = makeSelectChain(countRows);
    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    const hierarchyCache = {
      read: jest.fn((_orgId: string, _key: string, _ctx: unknown, fn: () => Promise<unknown>) => fn()),
    };
    const treeSource = {
      resolveReadProfile: jest.fn().mockResolvedValue({ mode: "ADJACENCY", revision: 1 }),
      buildAdjacencyTree: jest.fn().mockResolvedValue([]),
    };
    const svc = new OrgHierarchyReadService(db, hierarchyCache as never, treeSource as never);
    return { svc, where };
  }

  it("getHierarchy queries only the attacker org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.getHierarchy(ATTACKER, {} as never);
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
  });

  it("getHierarchy uses owner org scope (control)", async () => {
    const { svc, where } = makeService([{ kind: "BRANCH", count: 2 }]);
    await svc.getHierarchy(OWNER, {} as never);
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});
