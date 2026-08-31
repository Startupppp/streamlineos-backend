import type { Db } from "../../db/drizzle.module";
import { RbacService } from "./rbac.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("RbacService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }) });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const db = { select } as unknown as Db;
    return { db, where };
  }

  it("returns empty members for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const mockAccess = {} as any;
    const mockCache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()) } as any;
    const svc = new RbacService(db, mockAccess, mockCache);
    const result = await svc.getDiscoveryMembers(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns members for the owning org (control — same-tenant)", async () => {
    const memberRow = { userId: "u-1", name: "Alice", email: "alice@owner.com" };
    const { db } = makeDb([memberRow]);
    const mockAccess = {} as any;
    const mockCache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()) } as any;
    const svc = new RbacService(db, mockAccess, mockCache);
    const result = await svc.getDiscoveryMembers(OWNER);
    expect(result).toHaveLength(1);
  });
});
