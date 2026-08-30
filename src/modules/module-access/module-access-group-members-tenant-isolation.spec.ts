import type { Db } from "../../db/drizzle.module";
import { ModuleAccessGroupMembersService } from "./module-access-group-members.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("ModuleAccessGroupMembersService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockImplementation((a: unknown) => {
                wheres.push(a);
                return Object.assign(Promise.resolve([]), {
                  limit: jest.fn().mockResolvedValue([]),
                });
              }),
            }),
          }),
        }),
      })),
    } as unknown as Db;
  }

  const makeCache = () => ({ cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never);
  const makeAudit = () => ({ log: jest.fn().mockResolvedValue(undefined) } as never);
  const makeGroupPolicy = () => ({ permissionKeys: jest.fn().mockReturnValue(new Set()) } as never);

  it("scopes group members query to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new ModuleAccessGroupMembersService(makeDb(wheres), makeCache(), makeAudit(), makeGroupPolicy());

    await svc.fetchGroupMembers(ATTACKER, 1);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns members for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new ModuleAccessGroupMembersService(makeDb(wheres), makeCache(), makeAudit(), makeGroupPolicy());

    const result = await svc.fetchGroupMembers(OWNER, 1);

    expect(Array.isArray(result)).toBe(true);
  });
});
