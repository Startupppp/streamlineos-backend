import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OwnershipTransferResponseService } from "../ownership-transfer-response.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { revokeModuleOwnerRole, assertModuleOwnerRoleAssigned } from "../module-owner-role.helper";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction");
jest.mock("../../../common/auth/membership-state.service");
jest.mock("../../../common/rbac/sync-structural-role");
jest.mock("../../../common/rbac/access-invalidate");
jest.mock("../module-owner-role.helper");

type SelectChain = {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  orderBy: jest.Mock;
  for: jest.Mock;
};

function makeSelectChain(result: unknown[]): SelectChain {
  const chain: SelectChain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    orderBy: jest.fn(),
    for: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

type UpdateChain = {
  set: jest.Mock;
  where: jest.Mock;
  returning: jest.Mock;
};

function makeUpdateChain(result: unknown[] = []): UpdateChain {
  const chain: UpdateChain = {
    set: jest.fn(),
    where: jest.fn(),
    returning: jest.fn().mockResolvedValue(result),
  };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

type InsertChain = {
  values: jest.Mock;
  onConflictDoUpdate: jest.Mock;
};

function makeInsertChain(): InsertChain {
  const chain: InsertChain = {
    values: jest.fn(),
    onConflictDoUpdate: jest.fn().mockResolvedValue([]),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

function makeTenantTx(statusV2: string | null, hasHold: boolean) {
  return {
    select: jest.fn()
      .mockReturnValueOnce(makeSelectChain([{ statusV2 }]))
      .mockReturnValueOnce(makeSelectChain(hasHold ? [{ holdId: "hold-1" }] : [])),
  };
}

describe("OwnershipTransferResponseService — OWNERSHIP_TRANSFER lifecycle gate", () => {
  let service: OwnershipTransferResponseService;
  let mockDb: {
    select: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
    transaction: jest.Mock;
  };

  const ORG = "org-lifecycle-test";
  const TRANSFER_ID = "transfer-lc-1";
  const ACTOR_USER = "u-actor-lc";
  const FROM_USER = "u-from-lc";

  const pendingOrgTransfer = {
    id: TRANSFER_ID,
    scope: "ORGANIZATION" as const,
    moduleKey: null,
    fromMembershipId: 1,
    initiatedByMembershipId: 1,
    toMembershipId: 2,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 3_600_000),
  };

  const recipientMembership = {
    id: 2,
    userId: ACTOR_USER,
    isOwner: false,
    status: "ACTIVE",
  };

  const fromMember = { id: 1, userId: FROM_USER, isOwner: true, status: "ACTIVE" };
  const toMember = { id: 2, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };

  beforeEach(async () => {
    jest.resetAllMocks();

    jest.mocked(bustMembershipStatusCache).mockImplementation(() => Promise.resolve());
    jest.mocked(syncStructuralRoleAssignment).mockImplementation(() => Promise.resolve());
    jest.mocked(bumpPermissionsVersion).mockImplementation(() => Promise.resolve());
    jest.mocked(revokeModuleOwnerRole).mockImplementation(() => Promise.resolve());
    jest.mocked(assertModuleOwnerRoleAssigned).mockImplementation(() => Promise.resolve());

    mockDb = {
      select: jest.fn(),
      update: jest.fn(),
      insert: jest.fn(),
      transaction: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OwnershipTransferResponseService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = moduleRef.get(OwnershipTransferResponseService);
  });

  function setupCommonDbMocks(
    transfer = pendingOrgTransfer,
    membership = recipientMembership,
  ) {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([transfer]))
      .mockReturnValueOnce(makeSelectChain([membership]));
  }

  function setupOrgTransferTx() {
    const txMock = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ ownerMembershipId: 1 }]))
        .mockReturnValueOnce(makeSelectChain([fromMember, toMember])),
      update: jest.fn().mockReturnValue(makeUpdateChain([{ id: TRANSFER_ID }])),
    };
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    );
    return txMock;
  }

  describe("ORGANIZATION-scoped acceptance is gated on org lifecycle", () => {
    it("throws BadRequestException when an active legal hold exists", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", true) as any),
      );

      await expect(
        service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(jest.mocked(runInTenantTransaction)).toHaveBeenCalledTimes(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when the org statusV2 disallows the OWNERSHIP_TRANSFER transition", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ARCHIVED", false) as any),
      );

      await expect(
        service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(jest.mocked(runInTenantTransaction)).toHaveBeenCalledTimes(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("succeeds when the org is ACTIVE with no legal hold", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false) as any),
      );
      setupOrgTransferTx();

      const result = await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(result).toEqual({ success: true });
      expect(jest.mocked(runInTenantTransaction)).toHaveBeenCalledTimes(1);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("MODULE-scoped acceptance is NOT gated by the org lifecycle table", () => {
    const pendingModuleTransfer = {
      id: TRANSFER_ID,
      scope: "MODULE" as const,
      moduleKey: "hr",
      fromMembershipId: 1,
      initiatedByMembershipId: 1,
      toMembershipId: 2,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    };

    it("succeeds even when the org has an active legal hold", async () => {
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([pendingModuleTransfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]));

      const txMock = {
        select: jest.fn()
          .mockReturnValueOnce(makeSelectChain([{ ownerMembershipId: 1 }]))
          .mockReturnValueOnce(makeSelectChain([fromMember, toMember])),
        insert: jest.fn().mockReturnValue(makeInsertChain()),
        update: jest.fn().mockReturnValue(makeUpdateChain([{ id: TRANSFER_ID }])),
      };
      mockDb.transaction.mockImplementation(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      );

      const result = await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(result).toEqual({ success: true });
      expect(jest.mocked(runInTenantTransaction)).not.toHaveBeenCalled();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("legal-hold read happens inside a tenant transaction, not on the pool", () => {
    it("calls runInTenantTransaction with the correct orgId and invokes the callback", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ARCHIVED", true) as any),
      );

      await expect(
        service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(jest.mocked(runInTenantTransaction)).toHaveBeenCalledWith(
        mockDb,
        expect.any(Function),
        { orgId: ORG },
      );
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });
  });
});
