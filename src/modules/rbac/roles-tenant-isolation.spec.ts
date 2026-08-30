import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { RolesService } from "./roles.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("RolesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROLE_ID = 3;

  function makeDb(roleRow: unknown, listRows: unknown[] = []): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ groupBy: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(listRows) }) }) }) }) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const findFirst = jest.fn().mockResolvedValue(roleRow);
    const db = {
      select,
      query: {
        roles: { findFirst },
        hrPeople: { findMany: jest.fn().mockResolvedValue([]) },
        organizationMembers: { findMany: jest.fn().mockResolvedValue([]) },
      },
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: { roles: { findFirst } },
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
        select,
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
    return { db, where };
  }

  it("returns empty roles for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb(null, []);
    const mockAudit = { log: jest.fn() } as any;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue({}) } as any;
    const mockRolePerm = { getRolePermissions: jest.fn().mockResolvedValue([]) } as any;
    const mockRoleMember = {} as any;
    const svc = new RolesService(db, mockAudit, mockAccess, mockRolePerm, mockRoleMember);
    const result = await svc.getRoles(ATTACKER, { page: 1, limit: 20 });
    expect(result.roles).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("throws NotFoundException for a role in a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null);
    const mockAudit = { log: jest.fn() } as any;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue({}) } as any;
    const mockRolePerm = {} as any;
    const mockRoleMember = {} as any;
    const svc = new RolesService(db, mockAudit, mockAccess, mockRolePerm, mockRoleMember);
    await expect(svc.getRole(ATTACKER, ROLE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns roles for the owning org (control — same-tenant)", async () => {
    const roleRow = { id: ROLE_ID, orgId: OWNER, name: "Member", slug: "MEMBER" };
    const { db } = makeDb(roleRow, [roleRow]);
    const mockAudit = { log: jest.fn() } as any;
    const mockAccess = { resolveUserPermissions: jest.fn().mockResolvedValue({}) } as any;
    const mockRolePerm = { getRolePermissions: jest.fn().mockResolvedValue([]) } as any;
    const mockRoleMember = {} as any;
    const svc = new RolesService(db, mockAudit, mockAccess, mockRolePerm, mockRoleMember);
    const result = await svc.getRoles(OWNER, { page: 1, limit: 20 });
    expect(result.roles).toHaveLength(1);
  });
});
