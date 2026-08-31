import type { Db } from "../../db/drizzle.module";
import { ModuleAccessGroupCrudService } from "./module-access-group-crud.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("ModuleAccessGroupCrudService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    const chain = Object.assign(Promise.resolve([]), {
      orderBy: jest.fn().mockImplementation(() => Object.assign(Promise.resolve([]), {
        limit: jest.fn().mockResolvedValue([]),
      })),
      where: jest.fn().mockImplementation((a: unknown) => {
        wheres.push(a);
        return Object.assign(Promise.resolve([]), {
          groupBy: jest.fn().mockResolvedValue([]),
        });
      }),
      groupBy: jest.fn().mockResolvedValue([]),
    });
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return chain;
          }),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((a: unknown) => {
              wheres.push(a);
              return chain;
            }),
          }),
        }),
      })),
      selectDistinct: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Promise.resolve([]);
          }),
        }),
      })),
    } as unknown as Db;
  }

  const makeCache = () => ({
    cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()),
  } as never);

  const makeAccess = () => ({ hasPermission: jest.fn().mockResolvedValue(false) } as never);
  const makeAudit = () => ({ log: jest.fn().mockResolvedValue(undefined) } as never);
  const makeGroupPolicy = () => ({ permissionKeys: jest.fn().mockReturnValue(new Set()) } as never);

  it("scopes group list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new ModuleAccessGroupCrudService(makeDb(wheres), makeAccess(), makeCache(), makeAudit(), makeGroupPolicy());

    await svc.listGroups(ATTACKER, "build", 1);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns a cursor page with a data array for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new ModuleAccessGroupCrudService(makeDb(wheres), makeAccess(), makeCache(), makeAudit(), makeGroupPolicy());

    const result = await svc.listGroups(OWNER, "build", 1);

    expect(Array.isArray(result.data)).toBe(true);
    expect(result.pagination).toBeDefined();
  });
});
