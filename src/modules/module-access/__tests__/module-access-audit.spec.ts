import { Test } from "@nestjs/testing";
import { ModuleAccessGroupCrudService } from "../module-access-group-crud.service";
import { ModuleAccessGroupMembersService } from "../module-access-group-members.service";
import { ModuleAccessService } from "../module-access.service";
import { ModuleAccessGroupPolicyService } from "../module-access-group-policy.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { commitAccessChange } from "../../../common/rbac/access-mutation-commit";

jest.mock("../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-actor",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
    ...overrides,
  };
}

function makeFlexChain(results: unknown[]) {
  const resolved = Promise.resolve(results);
  const limitFn = jest.fn().mockResolvedValue(results);
  const thenable = {
    limit: limitFn,
    offset: jest.fn().mockReturnValue({ limit: limitFn }),
    orderBy: jest.fn(),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  (thenable.orderBy as jest.Mock).mockReturnValue(thenable);
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn().mockReturnValue(thenable),
    limit: limitFn,
    offset: jest.fn().mockReturnValue({ limit: limitFn }),
    orderBy: jest.fn().mockReturnValue(thenable),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  (chain.from as jest.Mock).mockReturnValue(chain);
  (chain.innerJoin as jest.Mock).mockReturnValue(chain);
  (chain.leftJoin as jest.Mock).mockReturnValue(chain);
  return chain;
}

function mockGroupPolicyService() {
  return {
    provide: ModuleAccessGroupPolicyService,
    useValue: {
      permissionKeys: jest.fn().mockReturnValue(new Set<string>()),
      assertGroupBelongsToModule: jest.fn().mockResolvedValue(undefined),
      resolveOwnerUserId: jest.fn().mockResolvedValue(null),
    },
  };
}

beforeEach(() => jest.mocked(commitAccessChange).mockClear());

describe("ModuleAccessGroupCrudService — audit: group created", () => {
  it("passes audit opts with module_access.group_created and moduleKey to commitAccessChange inside the transaction so the audit is atomic", async () => {

    const createdRow = { id: 42, name: "HR Admins", isSystem: false, version: 1 };
    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([createdRow]),
        }),
      }),
    };
    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        roles: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn() },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupCrudService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn(), cached: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        mockGroupPolicyService(),
      ],
    }).compile();

    await m.get(ModuleAccessGroupCrudService).createGroup(makeActor(), "hr", { name: "HR Admins" });

    expect(jest.mocked(commitAccessChange)).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        audit: expect.objectContaining({
          action: "module_access.group_created",
          metadata: expect.objectContaining({ moduleKey: "hr" }),
        }),
      }),
    );
  });
});

describe("ModuleAccessGroupCrudService — audit: group deleted", () => {
  it("passes audit opts with module_access.group_deleted and moduleKey to commitAccessChange so the audit row rolls back if the delete fails", async () => {

    const existingGroup = { id: 9, orgId: "org-1", moduleKey: "hr", isSystem: false, name: "Old Group" };
    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    };
    const mockDb = {
      // PRD-C073: "does this group still have assignments?" is a bounded limit-1 read now,
      // so no rows means no assignments. `[{ cnt: 0 }]` was one ROW and read as "assigned".
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        roles: { findFirst: jest.fn().mockResolvedValue(existingGroup) },
        organizationMembers: { findFirst: jest.fn() },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupCrudService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn(), cached: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        mockGroupPolicyService(),
      ],
    }).compile();

    await m.get(ModuleAccessGroupCrudService).deleteGroup(makeActor(), "hr", 9);

    expect(jest.mocked(commitAccessChange)).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        audit: expect.objectContaining({
          action: "module_access.group_deleted",
          metadata: expect.objectContaining({ moduleKey: "hr", name: "Old Group" }),
        }),
      }),
    );
  });
});

describe("ModuleAccessGroupMembersService — audit: group member added", () => {
  it("passes audit opts with module_access.group_member_added and targetUserId to commitAccessChange so membership changes are traceable", async () => {

    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 55, status: "ACTIVE" }),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupMembersService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        mockGroupPolicyService(),
      ],
    }).compile();

    await m
      .get(ModuleAccessGroupMembersService)
      .addGroupMember(makeActor(), "hr", 9, { userId: "u-target" });

    expect(jest.mocked(commitAccessChange)).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        audit: expect.objectContaining({
          action: "module_access.group_member_added",
          metadata: expect.objectContaining({ moduleKey: "hr", targetUserId: "u-target" }),
        }),
      }),
    );
  });
});

describe("ModuleAccessService — audit: role permissions set with diff", () => {
  it("passes added/removed diff in audit opts to commitAccessChange so permission changes are explainable inside the transaction", async () => {
    const role = {
      id: 5,
      slug: "CUSTOM_ROLE",
      name: "Custom Role",
      isSystem: false,
      version: 1,
      rank: 40,
      moduleKey: "hr",
      orgId: "org-1",
    };

    const existingGrants = [{ permissionKey: "hr:employees:view", scope: "all" }];

    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 5 }]),
          }),
        }),
      }),
      select: jest.fn().mockReturnValue(makeFlexChain(existingGrants)),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const mockDb = {
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        roles: { findFirst: jest.fn().mockResolvedValue(role) },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    await m.get(ModuleAccessService).setRolePermissions(makeActor(), "hr", 5, {
      version: 1,
      items: [{ permissionKey: "hr:employees:create", scope: "all" }],
    });

    const call = jest.mocked(commitAccessChange).mock.calls[0];
    const auditOpts = (call?.[2] as { audit?: Record<string, unknown> })?.audit ?? {};
    expect(auditOpts.action).toBe("module_access.role_permissions_set");
    const meta = auditOpts.metadata as Record<string, unknown>;
    expect(meta.moduleKey).toBe("hr");
    expect(meta.added).toEqual(expect.arrayContaining(["hr:employees:create"]));
    expect(meta.removed).toEqual([]);
  });

  it("caps the diff at 50 entries and sets truncated=true in audit opts so oversized diffs do not bloat the audit row", async () => {
    const role = {
      id: 5,
      slug: "CUSTOM_ROLE",
      name: "Custom Role",
      isSystem: false,
      version: 1,
      rank: 40,
      moduleKey: "hr",
      orgId: "org-1",
    };

    const existingGrants = Array.from({ length: 60 }, (_, i) => ({
      permissionKey: `hr:employees:action${i}`,
      scope: "all",
    }));

    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 5 }]),
          }),
        }),
      }),
      select: jest.fn().mockReturnValue(makeFlexChain(existingGrants)),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const mockDb = {
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        roles: { findFirst: jest.fn().mockResolvedValue(role) },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    await m.get(ModuleAccessService).setRolePermissions(makeActor(), "hr", 5, {
      version: 1,
      items: [],
    });

    const call = jest.mocked(commitAccessChange).mock.calls[0];
    const auditOpts = (call?.[2] as { audit?: Record<string, unknown> })?.audit ?? {};
    const meta = auditOpts.metadata as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect((meta.removed as string[]).length).toBeLessThanOrEqual(50);
  });
});
