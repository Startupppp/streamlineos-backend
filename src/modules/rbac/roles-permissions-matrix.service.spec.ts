import { RolesService } from "./roles.service";
import { ROLE_DEFAULT_PERMISSIONS } from "./permissions.constants";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

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

function makeDispatch(): NotificationDispatchService {
  return { emit: jest.fn() } as unknown as NotificationDispatchService;
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  } as unknown as AccessService;
}

function makeService(db: Db): RolesService {
  return new RolesService(db, makeCache(), makeAudit(), makeAccess(), makeDispatch());
}

describe("RolesService.getPermissionsMatrix", () => {
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
      permissions: ["settings:rbac:manage", "hr:employees:view"],
    });

    const salesEntry = result.find((r) => r.roleId === 2);
    expect(salesEntry).toEqual({
      roleId: 2,
      roleName: "Sales",
      roleSlug: "SALES",
      permissions: ["crm:leads:view"],
    });
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
      permissions: [],
    });
  });

  it("falls back to ROLE_DEFAULT_PERMISSIONS when no grants and role has no jsonb", async () => {
    const orgRoles: RoleRow[] = [
      { id: 5, name: "HR Manager", slug: "HR" },
    ];
    const grants: GrantRow[] = [];

    const { db } = buildMockDb(orgRoles, grants);
    const svc = makeService(db);

    const result = await svc.getPermissionsMatrix("org-3");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      roleId: 5,
      roleName: "HR Manager",
      roleSlug: "HR",
      permissions: ROLE_DEFAULT_PERMISSIONS["HR"],
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
      permissions: [],
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
    expect(adminEntry?.permissions).toEqual(["settings:rbac:manage"]);

    const engineerEntry = result.find((r) => r.roleId === 2);
    expect(engineerEntry?.permissions).toEqual(ROLE_DEFAULT_PERMISSIONS["ENGINEERING"]);
  });
});

export {};
