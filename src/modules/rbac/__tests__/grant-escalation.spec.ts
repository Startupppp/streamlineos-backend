import {
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { RbacService } from "../rbac.service";
import { RolePermissionService } from "../role-permission.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

const runInTenantTransactionMock = jest.fn();
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (
    db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
    opts?: unknown,
  ) => runInTenantTransactionMock(db, fn, opts),
}));

/**
 * Escalation coverage for the two writers over `role_permission_grants`.
 *
 * `grantability.spec.ts` already exercises `assertPermissionsGrantable` as a
 * pure function exhaustively. What it cannot see is whether a writer CALLS it,
 * and with what — and that was the gap: `RolePermissionService` passed the
 * actor's rank, the actor's modules, the target role's rank and the permission
 * module map, while `RbacService.assignRolePermission` passed the grantable set
 * and nothing else and never loaded the role at all. Two writers over one table
 * enforcing two different rules is not something a unit test of the shared
 * predicate can report.
 *
 * Every case below drives a real service method. Nothing asserts against the
 * predicate directly.
 */

const ROLE_RANK_ORG_ADMIN = 10;
const ROLE_RANK_MODULE_ADMIN = 20;
const ROLE_RANK_FUNCTIONAL = 40;

interface RoleRow {
  id: number;
  orgId: string;
  isSystem: boolean;
  version: number;
  rank: number;
  moduleKey: string | null;
  slug: string;
}

const customFunctionalRole: RoleRow = {
  id: 7,
  orgId: "org-1",
  isSystem: false,
  version: 1,
  rank: ROLE_RANK_FUNCTIONAL,
  moduleKey: null,
  slug: "CUSTOM_ROLE",
};

const orgLevelSystemRole: RoleRow = {
  ...customFunctionalRole,
  id: 2,
  isSystem: true,
  rank: ROLE_RANK_ORG_ADMIN,
  moduleKey: null,
  slug: "MEMBER",
};

const hrModuleAdminRole: RoleRow = {
  ...customFunctionalRole,
  id: 11,
  isSystem: true,
  rank: ROLE_RANK_MODULE_ADMIN,
  moduleKey: "hr",
  slug: "HR_MODULE_ADMIN",
};

const crmModuleAdminRole: RoleRow = {
  ...hrModuleAdminRole,
  id: 12,
  moduleKey: "crm",
  slug: "CRM_MODULE_ADMIN",
};

function actorContext(
  overrides: Partial<CurrentUserContext> = {},
): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    role: "ORG_ADMIN",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  } as CurrentUserContext;
}

const ownerActor = actorContext({
  userId: "owner-1",
  role: "OWNER",
  isOrgOwner: true,
  principal: humanSessionPrincipal(2, true),
});

interface DbOptions {
  role?: RoleRow;
  /** Rows `resolveActorRankContext` reads: the actor's own role assignments. */
  actorRoles?: { rank: number; moduleKey: string | null }[];
  /** The `organization_members` row `isStructuralOrgAdmin` reads. */
  member?: { isOwner: boolean; role: string } | undefined;
}

function makeTx() {
  return {
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        then: (resolve: (value: unknown) => unknown) => resolve([]),
      }),
    }),
  };
}

function makeDb(options: DbOptions, tx: ReturnType<typeof makeTx>): Db {
  const rankRows = options.actorRoles ?? [];
  const selectChain = {
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rankRows),
            }),
            limit: jest.fn().mockResolvedValue(rankRows),
          }),
        }),
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
  return {
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue(options.role) },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(options.member),
      },
    },
    select: jest.fn().mockReturnValue(selectChain),
    transaction: jest
      .fn()
      .mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

function makeAccess(held: readonly string[]): AccessService {
  return {
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(new Map(held.map((key) => [key, "all"]))),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  } as unknown as AccessService;
}

function makeCache(): CacheService {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateMany: jest.fn().mockResolvedValue(undefined),
    cached: jest
      .fn()
      .mockImplementation((_key: string, producer: () => Promise<unknown>) =>
        producer(),
      ),
  } as unknown as CacheService;
}

beforeEach(() => {
  jest.clearAllMocks();
  runInTenantTransactionMock.mockImplementation(
    (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe("RolePermissionService.setRolePermissions — escalation is refused", () => {
  function service(options: DbOptions, held: readonly string[]) {
    const tx = makeTx();
    runInTenantTransactionMock.mockImplementation(
      (_db: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    return new RolePermissionService(
      makeDb(options, tx),
      makeCache(),
      { log: jest.fn() } as unknown as AuditService,
      makeAccess(held),
    );
  }

  it("refuses a key the actor does not hold — no self-grant of unheld authority", async () => {
    const svc = service(
      { role: customFunctionalRole, actorRoles: [{ rank: ROLE_RANK_ORG_ADMIN, moduleKey: null }] },
      ["hr:employees:view"],
    );
    await expect(
      svc.setRolePermissions(actorContext(), customFunctionalRole.id, {
        version: 1,
        items: [{ permissionKey: "settings:manage", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses settings:rbac:manage from an actor who holds it but not settings:manage", async () => {
    const svc = service(
      { role: customFunctionalRole, actorRoles: [{ rank: ROLE_RANK_FUNCTIONAL, moduleKey: null }] },
      ["settings:rbac:manage"],
    );
    await expect(
      svc.setRolePermissions(actorContext(), customFunctionalRole.id, {
        version: 1,
        items: [{ permissionKey: "settings:rbac:manage", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a module admin granting outside their own module, even holding the key", async () => {
    const svc = service(
      {
        role: customFunctionalRole,
        actorRoles: [{ rank: ROLE_RANK_MODULE_ADMIN, moduleKey: "hr" }],
      },
      ["hr:employees:view", "crm:leads:view"],
    );
    await expect(
      svc.setRolePermissions(actorContext(), customFunctionalRole.id, {
        version: 1,
        items: [{ permissionKey: "crm:leads:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a module admin editing a peer-rank role in a DIFFERENT module", async () => {
    const svc = service(
      {
        role: crmModuleAdminRole,
        actorRoles: [{ rank: ROLE_RANK_MODULE_ADMIN, moduleKey: "hr" }],
      },
      ["hr:employees:view"],
    );
    await expect(
      svc.setRolePermissions(actorContext(), crmModuleAdminRole.id, {
        version: 1,
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("ALLOWS a module admin editing a peer-rank role in their OWN module — the deny is not blanket", async () => {
    const svc = service(
      {
        role: hrModuleAdminRole,
        actorRoles: [{ rank: ROLE_RANK_MODULE_ADMIN, moduleKey: "hr" }],
      },
      ["hr:employees:view"],
    );
    await expect(
      svc.setRolePermissions(actorContext(), hrModuleAdminRole.id, {
        version: 1,
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).resolves.toEqual({ success: true, version: 2 });
  });

  it("refuses an organisation-level system role to the org OWNER too", async () => {
    const svc = service({ role: orgLevelSystemRole }, []);
    await expect(
      svc.setRolePermissions(ownerActor, orgLevelSystemRole.id, {
        version: 1,
        items: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("RbacService.assignRolePermission — the second writer now enforces the same rules", () => {
  function service(options: DbOptions, held: readonly string[]) {
    return new RbacService(
      makeDb(options, makeTx()),
      makeAccess(held),
      makeCache(),
    );
  }

  const orgAdminMember = { isOwner: false, role: "ORG_ADMIN" };

  it("refuses an actor with no structural standing", async () => {
    const svc = service(
      { role: customFunctionalRole, member: { isOwner: false, role: "MEMBER" } },
      ["hr:employees:view"],
    );
    await expect(
      svc.assignRolePermission(actorContext({ role: "MEMBER" }), {
        roleId: customFunctionalRole.id,
        permissionKey: "hr:employees:view",
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s a role id belonging to another tenant instead of reaching the insert", async () => {
    const svc = service(
      { role: undefined, member: orgAdminMember },
      ["hr:employees:view"],
    );
    await expect(
      svc.assignRolePermission(actorContext(), {
        roleId: 9999,
        permissionKey: "hr:employees:view",
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(runInTenantTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses an organisation-level system role, matching setRolePermissions", async () => {
    const svc = service(
      { role: orgLevelSystemRole, member: orgAdminMember },
      ["settings:manage", "settings:rbac:manage"],
    );
    await expect(
      svc.assignRolePermission(actorContext(), {
        roleId: orgLevelSystemRole.id,
        permissionKey: "settings:rbac:manage",
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(runInTenantTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses the org owner an organisation-level system role as well", async () => {
    const svc = service({ role: orgLevelSystemRole, member: { isOwner: true, role: "OWNER" } }, []);
    await expect(
      svc.assignRolePermission(ownerActor, {
        roleId: orgLevelSystemRole.id,
        permissionKey: "hr:employees:view",
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a key the structural admin does not hold", async () => {
    const svc = service(
      {
        role: customFunctionalRole,
        member: orgAdminMember,
        actorRoles: [{ rank: ROLE_RANK_ORG_ADMIN, moduleKey: null }],
      },
      ["hr:employees:view"],
    );
    await expect(
      svc.assignRolePermission(actorContext(), {
        roleId: customFunctionalRole.id,
        permissionKey: "crm:leads:update",
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a target role at the actor's own rank — the rank rule now reaches this writer", async () => {
    const svc = service(
      {
        role: { ...customFunctionalRole, rank: ROLE_RANK_ORG_ADMIN, isSystem: false, moduleKey: null },
        member: orgAdminMember,
        actorRoles: [{ rank: ROLE_RANK_ORG_ADMIN, moduleKey: null }],
      },
      ["hr:employees:view"],
    );
    await expect(
      svc.assignRolePermission(actorContext(), {
        roleId: customFunctionalRole.id,
        permissionKey: "hr:employees:view",
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("ALLOWS a held key on a lower-rank role — the deny is not blanket", async () => {
    const svc = service(
      {
        role: customFunctionalRole,
        member: orgAdminMember,
        actorRoles: [{ rank: ROLE_RANK_ORG_ADMIN, moduleKey: null }],
      },
      ["hr:employees:view"],
    );
    await expect(
      svc.assignRolePermission(actorContext(), {
        roleId: customFunctionalRole.id,
        permissionKey: "hr:employees:view",
        scope: "all",
      }),
    ).resolves.toEqual({ success: true });
  });
});

describe("RbacService.revokeRolePermission — same role resolution", () => {
  function service(options: DbOptions) {
    return new RbacService(makeDb(options, makeTx()), makeAccess([]), makeCache());
  }

  it("404s a role id belonging to another tenant", async () => {
    const svc = service({ role: undefined, member: { isOwner: false, role: "ORG_ADMIN" } });
    await expect(
      svc.revokeRolePermission(actorContext(), {
        roleId: 9999,
        permissionKey: "hr:employees:view",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(runInTenantTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses an organisation-level system role", async () => {
    const svc = service({
      role: orgLevelSystemRole,
      member: { isOwner: false, role: "ORG_ADMIN" },
    });
    await expect(
      svc.revokeRolePermission(actorContext(), {
        roleId: orgLevelSystemRole.id,
        permissionKey: "hr:employees:view",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * "Idempotent" for a grant has to mean NATURALLY idempotent, not merely fenced.
 * `common/idempotency/command-fence-store.ts` swallows a failed completion write
 * by design ("a lost completion write just means the next retry re-executes
 * after the lease"), so a route that is only safe because of the fence is not
 * safe on the path the fence itself documents.
 */
describe("granting an already-granted permission is a no-op, not an error or a duplicate", () => {
  it("upserts on (org_id, role_id, permission_key) rather than inserting a second row", async () => {
    const tx = makeTx();
    runInTenantTransactionMock.mockImplementation(
      (_db: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new RbacService(
      makeDb(
        {
          role: customFunctionalRole,
          member: { isOwner: false, role: "ORG_ADMIN" },
          actorRoles: [{ rank: ROLE_RANK_ORG_ADMIN, moduleKey: null }],
        },
        tx,
      ),
      makeAccess(["hr:employees:view"]),
      makeCache(),
    );

    const input = {
      roleId: customFunctionalRole.id,
      permissionKey: "hr:employees:view",
      scope: "all" as const,
    };

    await expect(svc.assignRolePermission(actorContext(), input)).resolves.toEqual({
      success: true,
    });
    await expect(svc.assignRolePermission(actorContext(), input)).resolves.toEqual({
      success: true,
    });

    const valuesResult = tx.insert.mock.results[0]?.value as {
      values: jest.Mock;
    };
    const upsert = valuesResult.values.mock.results[0]?.value as {
      onConflictDoUpdate: jest.Mock;
    };
    expect(upsert.onConflictDoUpdate).toHaveBeenCalled();
    const target = upsert.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown[];
    };
    expect(target.target).toHaveLength(3);
  });
});
