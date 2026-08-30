import { OrgMembersService } from "./org-members.service";
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
    from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(), innerJoin: jest.fn(), leftJoin: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

describe("OrgMembersService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const MEMBER = { id: "u1", firstName: "Alice", lastName: "Smith", name: "Alice Smith", email: "alice@owner.com", image: null, role: "MEMBER" };

  function makeService(rows: unknown[]) {
    const { builder, where } = makeSelectChain(rows);
    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    const svc = new OrgMembersService(db);
    return { svc, where };
  }

  it("listMembers returns empty for a different org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.listMembers(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
  });

  it("listMembers returns members for the owning org (control)", async () => {
    const { svc } = makeService([MEMBER]);
    const result = await svc.listMembers(OWNER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "u1" });
  });
});
