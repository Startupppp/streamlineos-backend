import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { AccessService } from "../access/access.service";
import type { RoleMemberService } from "./role-member.service";
import type { RolePermissionService } from "./role-permission.service";
import { RolesService } from "./roles.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(resolveWith: unknown): Record<string, jest.Mock> & { then: unknown; catch: unknown; finally: unknown } {
  const chain: Record<string, jest.Mock> & { then: unknown; catch: unknown; finally: unknown } = {
    then: undefined as unknown,
    catch: undefined as unknown,
    finally: undefined as unknown,
  } as never;
  for (const m of ["from", "where", "leftJoin", "innerJoin", "groupBy", "orderBy", "limit", "offset"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.then = (fn: (v: unknown) => unknown) => Promise.resolve(resolveWith).then(fn);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(resolveWith).catch(fn);
  chain.finally = (fn: () => void) => Promise.resolve(resolveWith).finally(fn);
  return chain;
}

describe("RolesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROLE_ID = 3;

  function makeDb(roleRow: unknown, listRows: unknown[] = []): { db: Db; whereCalls: jest.Mock[] } {
    const pageChain = makeChain(listRows);
    const countChain = makeChain([{ value: listRows.length }]);
    let selectCount = 0;
    const select = jest.fn().mockImplementation(() => {
      selectCount++;
      return selectCount === 1 ? pageChain : countChain;
    });
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
    return { db, whereCalls: [pageChain.where, countChain.where] };
  }

  it("returns empty roles for a different org (cross-tenant isolation)", async () => {
    const { db, whereCalls } = makeDb(null, []);
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockAccess = stubService<AccessService>({ resolveUserPermissions: jest.fn().mockResolvedValue({}) });
    const mockRolePerm = stubService<RolePermissionService>({ getRolePermissions: jest.fn().mockResolvedValue([]) });
    const mockRoleMember = stubService<RoleMemberService>({});
    const svc = new RolesService(db, mockAudit, mockAccess, mockRolePerm, mockRoleMember);
    const result = await svc.getRoles(ATTACKER, { limit: 20 });
    expect(result.data).toHaveLength(0);
    const pageWhere = whereCalls[0];
    expect(pageWhere).toHaveBeenCalled();
    const allVals = pageWhere.mock.calls.flatMap((call: unknown[]) => sqlValues(call[0]));
    expect(allVals).toContain(ATTACKER);
    expect(allVals).not.toContain(OWNER);
  });

  it("throws NotFoundException for a role in a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null);
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockAccess = stubService<AccessService>({ resolveUserPermissions: jest.fn().mockResolvedValue({}) });
    const mockRolePerm = stubService<RolePermissionService>({});
    const mockRoleMember = stubService<RoleMemberService>({});
    const svc = new RolesService(db, mockAudit, mockAccess, mockRolePerm, mockRoleMember);
    await expect(svc.getRole(ATTACKER, ROLE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns roles for the owning org (control — same-tenant)", async () => {
    const roleRow = { id: ROLE_ID, orgId: OWNER, name: "Member", slug: "MEMBER" };
    const { db } = makeDb(roleRow, [roleRow]);
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockAccess = stubService<AccessService>({ resolveUserPermissions: jest.fn().mockResolvedValue({}) });
    const mockRolePerm = stubService<RolePermissionService>({ getRolePermissions: jest.fn().mockResolvedValue([]) });
    const mockRoleMember = stubService<RoleMemberService>({});
    const svc = new RolesService(db, mockAudit, mockAccess, mockRolePerm, mockRoleMember);
    const result = await svc.getRoles(OWNER, { limit: 20 });
    expect(result.data).toHaveLength(1);
  });
});
