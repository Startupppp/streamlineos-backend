import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleStandingMutationsService } from "../module-standing-mutations.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";

jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../ownership/module-owner-role.helper", () => ({
  revokeModuleOwnerRole: jest.fn().mockResolvedValue(undefined),
  assertModuleOwnerRoleAssigned: jest.fn().mockResolvedValue(undefined),
}));

const { revokeModuleOwnerRole, assertModuleOwnerRoleAssigned } = jest.requireMock(
  "../../ownership/module-owner-role.helper",
) as {
  revokeModuleOwnerRole: jest.Mock;
  assertModuleOwnerRoleAssigned: jest.Mock;
};

const MODULE = "hr";
const ORG = "org-1";
const ACTOR_USER = "u-actor";
const ACTOR_MEMBERSHIP_ID = 1;
const TARGET_MEMBERSHIP_ID = 2;
const TARGET_USER = "u-target";
const ADMIN_ROLE_ID = 42;

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: ACTOR_USER,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s-1",
    tokenScopes: null,
    ...overrides,
  };
}

function makeSelectChain(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const limitMock = jest.fn().mockResolvedValue(rows);
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn().mockReturnValue({ limit: limitMock }),
    limit: limitMock,
  };
  (chain.from as jest.Mock).mockReturnValue(chain);
  (chain.innerJoin as jest.Mock).mockReturnValue(chain);
  (chain.leftJoin as jest.Mock).mockReturnValue(chain);
  (chain.where as jest.Mock).mockReturnValue({
    limit: limitMock,
    then: resolved.then.bind(resolved),
  });
  return chain;
}

function makeTxMock() {
  return {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

async function buildSvc(mockDb: unknown, auditLog = jest.fn()) {
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
      { provide: CacheService, useValue: { invalidate: jest.fn().mockResolvedValue(undefined), invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
      { provide: AuditService, useValue: { log: auditLog } },
    ],
  }).compile();
  return m.get(ModuleStandingMutationsService);
}

describe("ModuleStandingMutationsService.grantAdminStanding", () => {
  it("grants MODULE_ADMIN standing and bumps permissions version", async () => {
    const auditLog = jest.fn();
    const txMock = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: ADMIN_ROLE_ID }])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildSvc(mockDb, auditLog);
    const result = await svc.grantAdminStanding(makeActor(), MODULE, TARGET_MEMBERSHIP_ID);

    expect(result).toEqual({ success: true });
    expect(bumpPermissionsVersion).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "module_access.standing_granted",
        metadata: expect.objectContaining({
          moduleKey: MODULE,
          rank: ROLE_RANK.MODULE_ADMIN,
          targetUserId: TARGET_USER,
        }),
      }),
    );
  });

  it("refuses if actor's rank does not permit granting MODULE_ADMIN", async () => {
    const moduleAdminRows = [{ rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "crm" }];
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockImplementation(({ where: _w }: { where: unknown }) => {
            return Promise.resolve({ isOwner: false, role: "MEMBER" });
          }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain(moduleAdminRows)),
    };

    const actor = makeActor({ isOrgOwner: false });
    const svc = await buildSvc(mockDb);
    await expect(svc.grantAdminStanding(actor, MODULE, TARGET_MEMBERSHIP_ID)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses grant to self for a non-owner actor", async () => {
    const txMock = makeTxMock();
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: ACTOR_MEMBERSHIP_ID, userId: ACTOR_USER }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
      transaction: jest.fn().mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    };

    const actor = makeActor({ isOrgOwner: false, userId: ACTOR_USER });
    const svc = await buildSvc(mockDb);
    await expect(
      svc.grantAdminStanding(actor, MODULE, ACTOR_MEMBERSHIP_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses grant when the module-admin system role is not seeded", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const svc = await buildSvc(mockDb);
    await expect(
      svc.grantAdminStanding(makeActor(), MODULE, TARGET_MEMBERSHIP_ID),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("ModuleStandingMutationsService.revokeStanding", () => {
  it("removes all module role assignments, bumps permissions, and audits", async () => {
    const auditLog = jest.fn();
    const txMock = {
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 5 }, { id: 6 }])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildSvc(mockDb, auditLog);
    const result = await svc.revokeStanding(makeActor(), MODULE, TARGET_MEMBERSHIP_ID);

    expect(result).toEqual({ success: true });
    expect(txMock.delete).toHaveBeenCalled();
    expect(bumpPermissionsVersion).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "module_access.standing_revoked",
        metadata: expect.objectContaining({ moduleKey: MODULE }),
      }),
    );
  });

  it("refuses to revoke the module owner's standing", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER }),
        },
      },
      select: jest.fn().mockReturnValueOnce(makeSelectChain([{ userId: TARGET_USER }])),
    };

    const svc = await buildSvc(mockDb);
    await expect(
      svc.revokeStanding(makeActor(), MODULE, TARGET_MEMBERSHIP_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it("returns 404 when the membership does not exist", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      select: jest.fn(),
    };

    const svc = await buildSvc(mockDb);
    await expect(
      svc.revokeStanding(makeActor(), MODULE, TARGET_MEMBERSHIP_ID),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("ModuleStandingMutationsService.directTransferOwnership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (bumpPermissionsVersion as jest.Mock).mockResolvedValue(undefined);
    revokeModuleOwnerRole.mockResolvedValue(undefined);
    assertModuleOwnerRoleAssigned.mockResolvedValue(undefined);
  });

  function makeTransferDb(prevOwnerMembershipId: number | null) {
    const prevRows = prevOwnerMembershipId !== null
      ? [{ ownerMembershipId: prevOwnerMembershipId }]
      : [];

    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(prevRows) }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };

    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: ACTOR_MEMBERSHIP_ID })
            .mockResolvedValueOnce({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER, status: "ACTIVE" }),
        },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    return { mockDb, txMock };
  }

  it("transfers ownership atomically: new owner assigned, old owner revoked in one transaction", async () => {
    const PREV_OWNER_ID = 99;
    const { mockDb, txMock } = makeTransferDb(PREV_OWNER_ID);

    const svc = await buildSvc(mockDb);
    const result = await svc.directTransferOwnership(makeActor(), MODULE, TARGET_MEMBERSHIP_ID);

    expect(result).toEqual({ success: true });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);

    expect(txMock.insert).toHaveBeenCalled();
    expect(txMock.update).toHaveBeenCalled();
    expect(revokeModuleOwnerRole).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      MODULE,
      PREV_OWNER_ID,
    );
    expect(assertModuleOwnerRoleAssigned).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      MODULE,
      TARGET_MEMBERSHIP_ID,
    );
    expect(bumpPermissionsVersion).toHaveBeenCalled();
  });

  it("the transaction mock must invoke its callback — all assertions inside run", async () => {
    const { mockDb } = makeTransferDb(null);
    let callbackRan = false;

    const innerTransaction = mockDb.transaction;
    mockDb.transaction = jest.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callbackRan = true;
        return innerTransaction(fn);
      },
    );

    const svc = await buildSvc(mockDb);
    await svc.directTransferOwnership(makeActor(), MODULE, TARGET_MEMBERSHIP_ID);

    expect(callbackRan).toBe(true);
    expect(assertModuleOwnerRoleAssigned).toHaveBeenCalled();
  });

  it("appoints a new owner for a module that currently has none (no revoke)", async () => {
    const { mockDb } = makeTransferDb(null);

    const svc = await buildSvc(mockDb);
    await svc.directTransferOwnership(makeActor(), MODULE, TARGET_MEMBERSHIP_ID);

    expect(revokeModuleOwnerRole).not.toHaveBeenCalled();
    expect(assertModuleOwnerRoleAssigned).toHaveBeenCalledTimes(1);
  });

  it("refuses the transfer when actor is not the org owner", async () => {
    const { mockDb } = makeTransferDb(null);
    const actor = makeActor({ isOrgOwner: false });

    const svc = await buildSvc(mockDb);
    await expect(
      svc.directTransferOwnership(actor, MODULE, TARGET_MEMBERSHIP_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses transfer to self", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: ACTOR_MEMBERSHIP_ID }),
        },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const svc = await buildSvc(mockDb);
    await expect(
      svc.directTransferOwnership(makeActor(), MODULE, ACTOR_MEMBERSHIP_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses transfer to inactive membership", async () => {
    const mockDb = {
      query: {
        organizationMembers: {
          findFirst: jest.fn()
            .mockResolvedValueOnce({ id: ACTOR_MEMBERSHIP_ID })
            .mockResolvedValueOnce({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER, status: "INACTIVE" }),
        },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const svc = await buildSvc(mockDb);
    await expect(
      svc.directTransferOwnership(makeActor(), MODULE, TARGET_MEMBERSHIP_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses transfer for a non-administrable module", async () => {
    const { mockDb } = makeTransferDb(null);
    const svc = await buildSvc(mockDb);

    await expect(
      svc.directTransferOwnership(makeActor(), "workflows", TARGET_MEMBERSHIP_ID),
    ).rejects.toThrow(ForbiddenException);
  });
});
