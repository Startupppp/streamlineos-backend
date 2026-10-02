import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessService } from "../module-access.service";
import { ModuleAccessRosterService } from "../module-access-roster.service";
import { ModuleAccessFlatMembersService } from "../module-access-flat-members.service";
import { ModuleAccessOwnershipService } from "../module-access-ownership.service";
import { ModuleAccessGroupPolicyService } from "../module-access-group-policy.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-actor",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
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

describe("ModuleAccessService.getCallerPermissions", () => {
  let svc: ModuleAccessService;
  let resolveUserPermissions: jest.Mock;
  let orgMemberFindFirst: jest.Mock;

  beforeEach(async () => {
    jest.resetAllMocks();
    resolveUserPermissions = jest.fn();

    const activeMembership = {
      id: 42,
      status: "ACTIVE",
      isOwner: false,
      role: "ORG_ADMIN",
    };

    orgMemberFindFirst = jest.fn().mockResolvedValue(activeMembership);

    const mockDb = {
      select: jest.fn(),
      query: { organizationMembers: { findFirst: orgMemberFindFirst } },
    };

    const selectChainForOwner = makeFlexChain([{ userId: "u-owner" }]);
    (mockDb.select as jest.Mock).mockReturnValue(selectChainForOwner);

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    svc = m.get(ModuleAccessService);
  });

  it("returns only permission keys prefixed with the requested module", async () => {
    resolveUserPermissions.mockResolvedValue(
      new Map([
        ["hr:employees:view", "all"],
        ["hr:employees:create", "own"],
        ["crm:leads:view", "all"],
        ["settings:rbac:manage", "all"],
      ]),
    );

    const result = await svc.getCallerPermissions(makeActor({ userId: "u-other" }), "hr");

    expect(result.permissions).toHaveLength(2);
    expect(result.permissions.every((p) => p.key.startsWith("hr:"))).toBe(true);
    expect(result.permissions.find((p) => p.key === "crm:leads:view")).toBeUndefined();
    expect(result.isOrgAdmin).toBe(true);
  });

  it("AC-04: isOrgAdmin is false for a reserved-key holder whose membership row is MEMBER", async () => {
    orgMemberFindFirst.mockResolvedValue({
      id: 42,
      status: "ACTIVE",
      isOwner: false,
      role: "MEMBER",
    });
    resolveUserPermissions.mockResolvedValue(
      new Map([
        ["hr:employees:view", "all"],
        ["settings:rbac:manage", "all"],
      ]),
    );

    const result = await svc.getCallerPermissions(makeActor({ userId: "u-other" }), "hr");

    expect(result.isOrgAdmin).toBe(false);
  });

  it("marks the caller as module owner when they own the module", async () => {
    resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));

    const result = await svc.getCallerPermissions(makeActor({ userId: "u-owner" }), "hr");

    expect(result.isModuleOwner).toBe(true);
  });

  it("does not label a custom-role manage grant as Module Admin authority", async () => {
    resolveUserPermissions.mockResolvedValue(
      new Map([["hr:access:manage", "all"]]),
    );

    const result = await svc.getCallerPermissions(
      makeActor({ userId: "u-custom-role" }),
      "hr",
    );

    expect(result.permissions).toContainEqual({
      key: "hr:access:manage",
      scope: "all",
    });
    expect(result.isModuleOwner).toBe(false);
    expect(result.isModuleAdmin).toBe(false);
  });

  it("throws ForbiddenException when the caller is not an active org member", async () => {
    const inactiveMockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessService,
        { provide: DRIZZLE, useValue: inactiveMockDb },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const restrictedSvc = m.get(ModuleAccessService);
    await expect(
      restrictedSvc.getCallerPermissions(makeActor(), "hr"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws NotFoundException for an unmanaged module", async () => {
    await expect(
      svc.getCallerPermissions(makeActor(), "billing"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ModuleAccessRosterService.listMembers — access guard", () => {
  it("throws ForbiddenException for a caller without module view access", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(new Map<string, string>());

    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      query: {
        roles: { findFirst: jest.fn() },
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 42, status: "ACTIVE", isOwner: false, role: "MEMBER" }),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessRosterService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const rosterSvc = m.get(ModuleAccessRosterService);

    await expect(
      rosterSvc.listMembers(makeActor({ isOrgOwner: false}), "hr", {
        pageSize: 20,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("requires manage access for a userId membership probe", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(
      new Map([["hr:access:view", "all"]]),
    );
    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      query: {
        roles: { findFirst: jest.fn() },
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 42, status: "ACTIVE", isOwner: false, role: "MEMBER" }),
        },
      },
    };
    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessRosterService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { cached: jest.fn(), invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    await expect(
      m.get(ModuleAccessRosterService).listMembers(makeActor(), "hr", {
        pageSize: 20,
        userId: "u-target",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ModuleAccessRosterService.listMemberCandidates — access guard", () => {
  it("requires manage access", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(
      new Map([["hr:access:view", "all"]]),
    );
    const mockDb = {
      select: jest.fn().mockReturnValue(makeFlexChain([])),
      query: {
        roles: { findFirst: jest.fn() },
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 42, status: "ACTIVE", isOwner: false, role: "MEMBER" }),
        },
      },
    };
    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessRosterService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { cached: jest.fn(), invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    await expect(
      m.get(ModuleAccessRosterService).listMemberCandidates(makeActor(), "hr"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ModuleAccessFlatMembersService.removeMember — module owner protection", () => {
  it("refuses to remove the module owner regardless of actor privileges", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(
      new Map([["hr:access:manage", "all"]]),
    );

    const ownerChain = makeFlexChain([{ userId: "u-module-owner" }]);
    const mockDb = {
      select: jest.fn().mockReturnValue(ownerChain),
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessFlatMembersService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const flatSvc = m.get(ModuleAccessFlatMembersService);

    await expect(
      flatSvc.removeMember(makeActor({ isOrgOwner: true }), "hr", "u-module-owner"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ModuleAccessFlatMembersService.addMember — self-assignment block", () => {
  it("blocks a non-owner actor from adding themselves to a module", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(
      new Map([["hr:access:manage", "all"]]),
    );

    const ownerChain = makeFlexChain([{ userId: "u-some-owner" }]);
    const mockDb = {
      select: jest.fn().mockReturnValue(ownerChain),
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessFlatMembersService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const flatSvc = m.get(ModuleAccessFlatMembersService);

    await expect(
      flatSvc.addMember(
        makeActor({ userId: "u-actor", isOrgOwner: false}),
        "hr",
        { userId: "u-actor", groupIds: [] },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows an org owner to add themselves to a module", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(new Map<string, string>());

    const ownerChain = makeFlexChain([{ userId: "u-other" }]);

    let selectCallCount = 0;
    const mockInsertChain = {
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue(mockInsertChain),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    };
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? ownerChain : makeFlexChain([{ id: 9 }]);
      }),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 12, status: "ACTIVE" }),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessFlatMembersService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions, isModuleEnabled: jest.fn().mockResolvedValue(true) } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const flatSvc = m.get(ModuleAccessFlatMembersService);

    const result = await flatSvc.addMember(
      makeActor({ userId: "u-actor", isOrgOwner: true }),
      "hr",
      { userId: "u-actor", groupIds: [9] },
    );

    expect(result).toEqual({ success: true });
  });

  /**
   * The schema allows 50 groups, so a per-row insert is up to 50 sequential
   * round trips holding a pooled connection inside one transaction — and
   * updateMemberGroups, three methods down the same file, already writes the
   * set in one statement.
   */
  it("writes every group assignment in one statement, not one per group", async () => {
    const groupIds = [9, 10, 11];
    const ownerChain = makeFlexChain([{ userId: "u-other" }]);
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({
      onConflictDoNothing,
      onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
    });
    const txMock = {
      execute: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({ values }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    };

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1
          ? ownerChain
          : makeFlexChain(groupIds.map((id) => ({ id })));
      }),
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 12, status: "ACTIVE" }),
        },
      },
    };

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessFlatMembersService,
        ModuleAccessGroupPolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, string>()),
            isModuleEnabled: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    await m.get(ModuleAccessFlatMembersService).addMember(
      makeActor({ userId: "u-actor", isOrgOwner: true }),
      "hr",
      { userId: "u-target", groupIds },
    );

    expect(txMock.insert).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenCalledWith(
      groupIds.map((roleId) => ({
        orgId: "org-1",
        organizationMembershipId: 12,
        roleId,
        assignedByMembershipId: null,
      })),
    );
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

describe("ModuleAccessOwnershipService authority", () => {
  const ownershipResult = {
    moduleKey: "hr",
    ownerId: "u-owner",
    ownerDisplayName: "Module Owner",
    ownerEmail: "owner@example.com",
    pendingTransfer: null,
  };

  async function buildOwnershipSvc(ownerUserId = "u-owner") {
    const select = jest
      .fn()
      .mockReturnValue(
        makeFlexChain([{ userId: ownerUserId, ownerMembershipId: 11 }]),
      );
    const cached = jest.fn().mockResolvedValue(ownershipResult);
    const resolveUserPermissions = jest
      .fn()
      .mockResolvedValue(new Map([["hr:access:manage", "all"]]));
    const findFirst = jest.fn();
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    };
    const transaction = jest
      .fn()
      .mockImplementation(async (work: (value: typeof tx) => Promise<unknown>) =>
        work(tx),
      );
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const invalidateNamespace = jest.fn().mockResolvedValue(undefined);
    const invalidateNamespaceForOrg = jest.fn().mockResolvedValue(undefined);

    const m = await Test.createTestingModule({
      providers: [
        ModuleAccessOwnershipService,
        ModuleAccessGroupPolicyService,
        {
          provide: DRIZZLE,
          useValue: {
            select,
            transaction,
            query: {
              organizationMembers: { findFirst },
              roles: { findFirst: jest.fn() },
            },
          },
        },
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions,
            isModuleEnabled: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: CacheService,
          useValue: { cached, invalidate, invalidateNamespace, invalidateNamespaceForOrg },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    return {
      svc: m.get(ModuleAccessOwnershipService),
      cached,
      resolveUserPermissions,
      select,
      findFirst,
      insertValues,
    };
  }

  it("allows the actual module owner to read ownership details", async () => {
    const { svc, cached } = await buildOwnershipSvc();

    await expect(
      svc.getOwnership(makeActor({ userId: "u-owner" }), "hr"),
    ).resolves.toEqual(ownershipResult);
    expect(cached).toHaveBeenCalledTimes(1);
  });

  it("allows the organization owner as the documented break-glass owner", async () => {
    const { svc, cached, select } = await buildOwnershipSvc();

    await expect(
      svc.getOwnership(
        makeActor({ userId: "u-org-owner", isOrgOwner: true }),
        "hr",
      ),
    ).resolves.toEqual(ownershipResult);
    expect(cached).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("allows the actual module owner to initiate an ownership transfer", async () => {
    const { svc, findFirst, insertValues } = await buildOwnershipSvc();
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 11 })
      .mockResolvedValueOnce({ id: 12, status: "ACTIVE" });

    await expect(
      svc.initiateTransfer(
        makeActor({ userId: "u-owner" }),
        "hr",
        "u-target",
      ),
    ).resolves.toEqual({ success: true });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        moduleKey: "hr",
        fromMembershipId: 11,
        initiatedByMembershipId: 11,
        toMembershipId: 12,
      }),
    );
  });

  it.each([
    ["Org Admin", { role: "ORG_ADMIN" }],
    ["Module Admin", {}],
    ["functional member", { userId: "u-functional" }],
  ])(
    "denies ownership details to a non-owner %s even when manage is effectively granted",
    async (_label, overrides) => {
      const { svc, cached, resolveUserPermissions } =
        await buildOwnershipSvc("u-owner");

      await expect(
        svc.getOwnership(makeActor(overrides), "hr"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(cached).not.toHaveBeenCalled();
      expect(resolveUserPermissions).not.toHaveBeenCalled();
    },
  );

  it.each(["initiate", "cancel"] as const)(
    "denies a Module Admin attempting to %s an ownership transfer",
    async (operation) => {
      const { svc } = await buildOwnershipSvc("u-owner");
      const moduleAdmin = makeActor({ userId: "u-module-admin" });

      const request =
        operation === "initiate"
          ? svc.initiateTransfer(moduleAdmin, "hr", "u-target")
          : svc.cancelTransfer(moduleAdmin, "hr");

      await expect(request).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
