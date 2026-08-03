import { Test } from "@nestjs/testing";
import { ModuleAccessGroupsService } from "../module-access-groups.service";
import { ModuleAccessService } from "../module-access.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-actor",
    orgId: "org-1",
    role: "MEMBER",
    permissions: [],
    isOrgOwner: true,
    sessionId: "s-1",
    tokenScopes: null,
    ...overrides,
  };
}

function makeFlexChain(results: unknown[]) {
  const resolved = Promise.resolve(results);
  const limitFn = jest.fn().mockResolvedValue(results);
  const whereReturn: Record<string, unknown> = {
    limit: limitFn,
    offset: jest.fn().mockReturnValue({ limit: limitFn }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn().mockReturnValue(whereReturn),
    limit: limitFn,
    offset: jest.fn().mockReturnValue({ limit: limitFn }),
    orderBy: jest.fn(),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  (chain.from as jest.Mock).mockReturnValue(chain);
  (chain.innerJoin as jest.Mock).mockReturnValue(chain);
  (chain.leftJoin as jest.Mock).mockReturnValue(chain);
  (chain.orderBy as jest.Mock).mockReturnValue(chain);
  return chain;
}

describe("ModuleAccessGroupsService — audit: group created", () => {
  it("logs module_access.group_created with moduleKey after the transaction commits", async () => {
    const auditLog = jest.fn();

    const createdRow = { id: 42, name: "HR Admins", isSystem: false, version: 1 };
    const txMock = {
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
        ModuleAccessGroupsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();

    await m.get(ModuleAccessGroupsService).createGroup(makeActor(), "hr", { name: "HR Admins" });

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "module_access.group_created",
        metadata: expect.objectContaining({ moduleKey: "hr" }),
      }),
    );
  });
});

describe("ModuleAccessGroupsService — audit: group deleted", () => {
  it("logs module_access.group_deleted with moduleKey after the transaction commits", async () => {
    const auditLog = jest.fn();

    const existingGroup = { id: 9, orgId: "org-1", moduleKey: "hr", isSystem: false, name: "Old Group" };
    const txMock = {
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    };
    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([{ cnt: 0 }])),
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
        ModuleAccessGroupsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();

    await m.get(ModuleAccessGroupsService).deleteGroup(makeActor(), "hr", 9);

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "module_access.group_deleted",
        metadata: expect.objectContaining({ moduleKey: "hr", name: "Old Group" }),
      }),
    );
  });
});

describe("ModuleAccessGroupsService — audit: group member added", () => {
  it("logs module_access.group_member_added with moduleKey and targetUserId", async () => {
    const auditLog = jest.fn();

    const groupRow = { id: 9, orgId: "org-1", moduleKey: "hr" };
    const txMock = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        roles: { findFirst: jest.fn().mockResolvedValue(groupRow) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 55 }) },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessGroupsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();

    await m
      .get(ModuleAccessGroupsService)
      .addGroupMember(makeActor(), "hr", 9, { userId: "u-target" });

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "module_access.group_member_added",
        metadata: expect.objectContaining({ moduleKey: "hr", targetUserId: "u-target" }),
      }),
    );
  });
});

describe("ModuleAccessService — audit: role permissions set with diff", () => {
  it("logs module_access.role_permissions_set with correct added/removed diff after the transaction", async () => {
    const auditLog = jest.fn();

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
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();

    await m.get(ModuleAccessService).setRolePermissions(makeActor(), "hr", 5, {
      version: 1,
      items: [{ permissionKey: "hr:employees:create", scope: "all" }],
    });

    expect(auditLog).toHaveBeenCalledTimes(1);
    const call = auditLog.mock.calls[0][0] as Record<string, unknown>;
    expect(call.action).toBe("module_access.role_permissions_set");
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.moduleKey).toBe("hr");
    expect(meta.added).toEqual(expect.arrayContaining(["hr:employees:create"]));
    expect(meta.removed).toEqual(expect.arrayContaining(["hr:employees:view"]));
  });

  it("logs module_access.role_permissions_set with truncated=true when diff exceeds the cap", async () => {
    const auditLog = jest.fn();

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
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();

    await m.get(ModuleAccessService).setRolePermissions(makeActor(), "hr", 5, {
      version: 1,
      items: [],
    });

    expect(auditLog).toHaveBeenCalledTimes(1);
    const call = auditLog.mock.calls[0][0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect((meta.removed as string[]).length).toBeLessThanOrEqual(50);
  });
});
