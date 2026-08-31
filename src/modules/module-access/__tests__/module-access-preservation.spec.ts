import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleStandingMutationsService } from "../module-standing-mutations.service";
import { ModuleAccessGroupCrudService } from "../module-access-group-crud.service";
import { ModuleAccessGroupMembersService } from "../module-access-group-members.service";
import { UserPermissionGrantsService } from "../user-permission-grants.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { ModuleAccessGroupPolicyService } from "../module-access-group-policy.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";

const txDeletes: number[] = [];
const txInserted: Record<string, unknown>[] = [];
let txVersionBumped = 0;

jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockImplementation(() => {
    txVersionBumped += 1;
    return Promise.resolve();
  }),
}));

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<void>) =>
    fn({
      delete: () => ({
        where: () => {
          txDeletes.push(1);
          return Promise.resolve();
        },
      }),
      insert: () => ({
        values: (rows: Record<string, unknown>[]) => {
          txInserted.push(...rows);
          return Promise.resolve();
        },
      }),
    }),
}));

jest.mock("../../ownership/module-owner-role.helper", () => ({
  revokeModuleOwnerRole: jest.fn().mockResolvedValue(undefined),
  assertModuleOwnerRoleAssigned: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../module-access.helpers", () => ({
  ...jest.requireActual<typeof import("../module-access.helpers")>(
    "../module-access.helpers",
  ),
  resolveActorRankContext: jest.fn().mockResolvedValue({
    bestRank: 10,
    allowedModules: new Set(["hr", "crm", "build", "payroll", "inventory"]),
  }),
}));

const ORG = "org-preservation";
const MODULE = "hr";

function nonOwnerActor(userId = "u-plain", role = "MEMBER"): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role,
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function ownerActor(userId = "u-owner"): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s-2",
    tokenScopes: null,
    principal: humanSessionPrincipal(2, true),
  };
}

function makeSelectChain(rows: unknown[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn().mockReturnValue({ limit: limitMock }),
    limit: limitMock,
  };
  (chain.from as jest.Mock).mockReturnValue(chain);
  (chain.innerJoin as jest.Mock).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  txDeletes.length = 0;
  txInserted.length = 0;
  txVersionBumped = 0;
  (bumpPermissionsVersion as jest.Mock).mockClear();
});

describe("Condition 1 — module standing gate bites for isOrgOwner=false with no module standing", () => {
  it("grantAdminStanding is denied: non-owner with no admin rank in this module throws ForbiddenException", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 5, userId: "u-target" }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ rank: 20, moduleKey: "crm" }])),
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleStandingMutationsService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: AccessService,
          useValue: {
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateNamespace: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const svc = m.get(ModuleStandingMutationsService);

    expect(nonOwnerActor().isOrgOwner).toBe(false);
    await expect(
      svc.grantAdminStanding(nonOwnerActor(), MODULE, 5),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("revokeStanding is denied: non-owner with no admin rank in this module throws ForbiddenException", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 5, userId: "u-target" }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ rank: 20, moduleKey: "crm" }])),
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleStandingMutationsService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: AccessService,
          useValue: {
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateNamespace: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    expect(nonOwnerActor().isOrgOwner).toBe(false);
    await expect(
      m.get(ModuleStandingMutationsService).revokeStanding(nonOwnerActor(), MODULE, 5),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("Condition 2 — system roles are immutable: custom role gate bites", () => {
  it("deleteGroup is forbidden for a system role — no transaction is opened", async () => {
    const systemRole = { id: 10, orgId: ORG, moduleKey: MODULE, isSystem: true, name: "Module Admin" };
    const mockDb = {
      query: { roles: { findFirst: jest.fn().mockResolvedValue(systemRole) } },
      select: jest.fn().mockReturnValue(makeSelectChain([{ cnt: 0 }])),
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupCrudService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn(), cached: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ModuleAccessGroupPolicyService,
          useValue: { permissionKeys: jest.fn().mockReturnValue(new Set()), resolveOwnerUserId: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    const deletesBefore = txDeletes.length;
    await expect(
      m.get(ModuleAccessGroupCrudService).deleteGroup(ownerActor(), MODULE, 10),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(txDeletes.length).toBe(deletesBefore);
  });

  it("renameGroup is forbidden for a system role — no transaction is opened", async () => {
    const systemRole = { id: 10, orgId: ORG, moduleKey: MODULE, isSystem: true, name: "Module Admin" };
    const mockDb = {
      query: { roles: { findFirst: jest.fn().mockResolvedValue(systemRole) } },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupCrudService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn(), cached: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ModuleAccessGroupPolicyService,
          useValue: { permissionKeys: jest.fn().mockReturnValue(new Set()), resolveOwnerUserId: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    const deletesBefore = txDeletes.length;
    await expect(
      m.get(ModuleAccessGroupCrudService).renameGroup(ownerActor(), MODULE, 10, { name: "Renamed" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(txDeletes.length).toBe(deletesBefore);
  });
});

describe("Condition 3 — principal group membership drives permission via transactional role assignment", () => {
  it("removeGroupMember writes the deletion and the version bump in the same transaction callback", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 55 }),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupMembersService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: { invalidate: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ModuleAccessGroupPolicyService,
          useValue: { resolveOwnerUserId: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    const deletesBefore = txDeletes.length;
    const bumpBefore = txVersionBumped;

    await m.get(ModuleAccessGroupMembersService).removeGroupMember(ownerActor(), MODULE, 9, "u-target");

    expect(txDeletes.length).toBeGreaterThan(deletesBefore);
    expect(txVersionBumped).toBeGreaterThan(bumpBefore);
  });

  it("removing a non-existent member is a no-op and opens no transaction", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupMembersService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ModuleAccessGroupPolicyService,
          useValue: { resolveOwnerUserId: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    const deletesBefore = txDeletes.length;
    const result = await m.get(ModuleAccessGroupMembersService).removeGroupMember(ownerActor(), MODULE, 9, "u-gone");
    expect(result).toEqual({ success: true });
    expect(txDeletes.length).toBe(deletesBefore);
  });
});

describe("Condition 4 — direct grants are tied to membership, not role", () => {
  it("setGrants inserts rows with organizationMembershipId and no roleId column", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, userId: "u-target", status: "ACTIVE" }),
        },
      },
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };

    const svc = new UserPermissionGrantsService(
      mockDb as never,
      { assertModuleAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {
        resolveUserPermissions: jest.fn().mockResolvedValue(
          new Map([["hr:employees:view", "all"]]),
        ),
      } as never,
      { log: jest.fn() } as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await svc.setGrants(nonOwnerActor("u-grantor"), "hr", 7, {
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
    });

    expect(txInserted).toHaveLength(1);
    const row = txInserted[0];
    expect(row).toMatchObject({ organizationMembershipId: 7 });
    expect(Object.keys(row ?? {})).not.toContain("roleId");
  });

  it("removeGrant deletes a grant without touching role tables", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, userId: "u-target", status: "ACTIVE" }),
        },
      },
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };

    const svc = new UserPermissionGrantsService(
      mockDb as never,
      { assertModuleAccess: jest.fn().mockResolvedValue(undefined) } as never,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) } as never,
      { log: jest.fn() } as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const deletesBefore = txDeletes.length;
    const insertsBefore = txInserted.length;

    await svc.removeGrant(nonOwnerActor("u-grantor"), "hr", 7, "hr:employees:view");

    expect(txDeletes.length).toBeGreaterThan(deletesBefore);
    expect(txInserted.length).toBe(insertsBefore);
  });
});

describe("Condition 5 — data scope ceiling: grantor cannot mint wider access than they hold", () => {
  it("refuses setGrants when requested scope exceeds grantor's own scope, with no write occurring", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, userId: "u-target", status: "ACTIVE" }),
        },
      },
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };

    const svc = new UserPermissionGrantsService(
      mockDb as never,
      { assertModuleAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {
        resolveUserPermissions: jest.fn().mockResolvedValue(
          new Map([["hr:employees:view", "team"]]),
        ),
      } as never,
      { log: jest.fn() } as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const insertsBefore = txInserted.length;

    await expect(
      svc.setGrants(nonOwnerActor("u-grantor"), "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(txInserted.length).toBe(insertsBefore);
  });
});

describe("Condition 6 — canonical-owner-only: directTransferOwnership requires isOrgOwner", () => {
  it("refuses directTransferOwnership for an org admin who is not the org owner (isOrgOwner=false probe)", async () => {
    const mockDb = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleStandingMutationsService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: AccessService,
          useValue: {
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateNamespace: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const orgAdmin = nonOwnerActor("u-org-admin", "ORG_ADMIN");
    expect(orgAdmin.isOrgOwner).toBe(false);

    await expect(
      m.get(ModuleStandingMutationsService).directTransferOwnership(orgAdmin, MODULE, 5),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses directTransferOwnership for a plain member (isOrgOwner=false probe)", async () => {
    const mockDb = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleStandingMutationsService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: AccessService,
          useValue: {
            isModuleEnabled: jest.fn().mockResolvedValue(true),
            resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateNamespace: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const plain = nonOwnerActor("u-plain");
    expect(plain.isOrgOwner).toBe(false);

    await expect(
      m.get(ModuleStandingMutationsService).directTransferOwnership(plain, MODULE, 5),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
