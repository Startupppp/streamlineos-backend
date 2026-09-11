import { RolePermissionService } from "./role-permission.service";
import { ROLE_DEFAULT_PERMISSIONS, UNIVERSAL_MEMBER_PERMISSIONS } from "./permissions";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";

type RoleRow = { id: number; name: string; slug: string };
type GrantRow = { roleId: number; permissionKey: string };

interface RoleSelectChain {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

interface GrantSelectChain {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
}

function buildRoleChain(resolvedValue: RoleRow[]): RoleSelectChain {
  const chain: RoleSelectChain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(resolvedValue),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

function buildGrantChain(resolvedValue: GrantRow[]): GrantSelectChain {
  const chain: GrantSelectChain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(resolvedValue),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function buildMockDb(rolesResult: RoleRow[], grantsResult: GrantRow[]) {
  let callCount = 0;

  const selectFn = jest.fn().mockImplementation(() => {
    callCount += 1;
    if (callCount === 1) {
      return buildRoleChain(rolesResult);
    }
    return buildGrantChain(grantsResult);
  });

  const db = { select: selectFn } as Partial<Db> as Db;
  return { db, selectFn };
}

function makeCache(): CacheService {
  return new CacheService(null);
}

function makeAudit(): AuditService {
  return { log: jest.fn() } as Partial<AuditService> as AuditService;
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  } as unknown as AccessService;
}

function makeService(db: Db): RolePermissionService {
  return new RolePermissionService(db, makeCache(), makeAudit(), makeAccess());
}

describe("RolePermissionService.getPermissionsMatrix", () => {
  it("returns an entry per role with permissions from grants when grants exist", async () => {
    const orgRoles: RoleRow[] = [
      { id: 1, name: "Admin", slug: "OWNER" },
      { id: 2, name: "Sales", slug: "SALES" },
    ];
    const grants: GrantRow[] = [
      { roleId: 1, permissionKey: "settings:rbac:manage" },
      { roleId: 1, permissionKey: "hr:employees:view" },
      { roleId: 2, permissionKey: "crm:leads:view" },
    ];

    const { db } = buildMockDb(orgRoles, grants);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-1");

    expect(result).toHaveLength(2);

    const adminEntry = result.find((r) => r.roleId === 1);
    expect(adminEntry).toEqual({
      roleId: 1,
      roleName: "Admin",
      roleSlug: "OWNER",
      permissions: [...UNIVERSAL_MEMBER_PERMISSIONS, "settings:rbac:manage", "hr:employees:view"],
    });

    const salesEntry = result.find((r) => r.roleId === 2);
    expect(salesEntry).toEqual({
      roleId: 2,
      roleName: "Sales",
      roleSlug: "SALES",
      permissions: [...UNIVERSAL_MEMBER_PERMISSIONS, "crm:leads:view"],
    });
  });

  it("returns grants for every requested role with no silent truncation", async () => {
    const roles: RoleRow[] = [
      { id: 1, name: "Admin", slug: "ADMIN" },
      { id: 2, name: "Manager", slug: "MANAGER" },
      { id: 3, name: "Employee", slug: "EMPLOYEE" },
    ];
    const grants: GrantRow[] = [
      { roleId: 1, permissionKey: "hr:employees:view" },
      { roleId: 1, permissionKey: "hr:employees:create" },
      { roleId: 2, permissionKey: "hr:employees:view" },
      { roleId: 3, permissionKey: "hr:employees:view" },
    ];

    const { db } = buildMockDb(roles, grants);
    const result = await makeService(db).getPermissionsMatrix("org-1");

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.roleId)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(result.find((r) => r.roleId === 1)?.permissions).toEqual(
      expect.arrayContaining(["hr:employees:view", "hr:employees:create"]),
    );
    expect(result.find((r) => r.roleId === 2)?.permissions).toEqual([...UNIVERSAL_MEMBER_PERMISSIONS, "hr:employees:view"]);
    expect(result.find((r) => r.roleId === 3)?.permissions).toEqual([...UNIVERSAL_MEMBER_PERMISSIONS, "hr:employees:view"]);
  });

  it("falls back to ROLE_DEFAULT_PERMISSIONS when no grants exist for a custom slug with no default", async () => {
    const orgRoles: RoleRow[] = [
      { id: 10, name: "Custom", slug: "CUSTOM_SLUG" },
    ];
    const grants: GrantRow[] = [];

    const { db } = buildMockDb(orgRoles, grants);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-2");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      roleId: 10,
      roleName: "Custom",
      roleSlug: "CUSTOM_SLUG",
      permissions: [...UNIVERSAL_MEMBER_PERMISSIONS],
    });
  });

  it("falls back to ROLE_DEFAULT_PERMISSIONS when no grants and role slug has a catalog entry", async () => {
    const orgRoles: RoleRow[] = [
      { id: 5, name: "Member", slug: "MEMBER" },
    ];
    const grants: GrantRow[] = [];

    const { db } = buildMockDb(orgRoles, grants);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-3");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      roleId: 5,
      roleName: "Member",
      roleSlug: "MEMBER",
      permissions: Array.from(new Set([...UNIVERSAL_MEMBER_PERMISSIONS, ...(ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? [])])),
    });
  });

  it("returns an empty array when the org has no roles", async () => {
    const { db } = buildMockDb([], []);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-empty");

    expect(result).toEqual([]);
  });

  it("resolves with an empty permissions array when slug has no default and no grants", async () => {
    const orgRoles: RoleRow[] = [
      { id: 99, name: "Unknown Role", slug: "UNKNOWN_SLUG_WITH_NO_DEFAULT" },
    ];
    const grants: GrantRow[] = [];

    const { db } = buildMockDb(orgRoles, grants);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-4");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      roleId: 99,
      roleName: "Unknown Role",
      roleSlug: "UNKNOWN_SLUG_WITH_NO_DEFAULT",
      permissions: [...UNIVERSAL_MEMBER_PERMISSIONS],
    });
  });

  it("grants for one role do not contaminate another role that has no grants", async () => {
    const orgRoles: RoleRow[] = [
      { id: 1, name: "Admin", slug: "OWNER" },
      { id: 2, name: "Engineer", slug: "ENGINEERING" },
    ];
    const grants: GrantRow[] = [
      { roleId: 1, permissionKey: "settings:rbac:manage" },
    ];

    const { db } = buildMockDb(orgRoles, grants);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-5");

    const adminEntry = result.find((r) => r.roleId === 1);
    expect(adminEntry?.permissions).toEqual([...UNIVERSAL_MEMBER_PERMISSIONS, "settings:rbac:manage"]);

    const engineerEntry = result.find((r) => r.roleId === 2);
    expect(engineerEntry?.permissions).toEqual([...UNIVERSAL_MEMBER_PERMISSIONS]);
  });
});

export {};
