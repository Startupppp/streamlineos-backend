import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OwnershipService } from "../ownership.service";
import { OwnershipTransfersService } from "../ownership-transfers.service";
import { OwnershipTransferExpiryService } from "../ownership-transfer-expiry.service";
import { OwnershipTransferResponseService } from "../ownership-transfer-response.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OrganizationSagaService } from "../../organization/core/lifecycle/organization-saga.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

type SelectChain = {
  from: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  orderBy: jest.Mock;
  for: jest.Mock;
  returning: jest.Mock;
};

function makeSelectChain(result: unknown[]): SelectChain {
  const chain: SelectChain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    orderBy: jest.fn(),
    for: jest.fn().mockResolvedValue(result),
    returning: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

type UpdateChain = {
  set: jest.Mock;
  where: jest.Mock;
  returning: jest.Mock;
};

function makeUpdateChain(result: unknown[] = [{ id: "updated" }]): UpdateChain {
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
  returning: jest.Mock;
  onConflictDoUpdate: jest.Mock;
  onConflictDoNothing: jest.Mock;
};

function makeInsertChain(result: unknown[]): InsertChain {
  const chain: InsertChain = {
    values: jest.fn(),
    returning: jest.fn().mockResolvedValue(result),
    onConflictDoUpdate: jest.fn().mockResolvedValue([]),
    onConflictDoNothing: jest.fn().mockResolvedValue([]),
  };
  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockReturnValue(chain);
  chain.onConflictDoNothing.mockReturnValue(chain);
  return chain;
}

describe("OwnershipService — access / business-rule logic", () => {
  let ownership: OwnershipService;
  let transfers: OwnershipTransfersService;
  let responses: OwnershipTransferResponseService;
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
    query: { organizationMembers: { findFirst: jest.Mock } };
  };

  const ORG = "org-unit-test";
  const ACTOR_USER = "u-actor";
  const TARGET_USER = "u-target";

  function makeActor(isOrgOwner: boolean): CurrentUserContext {
    return {
      orgId: ORG,
      userId: ACTOR_USER,
      role: isOrgOwner ? "OWNER" : "MEMBER",
      isOrgOwner,
      sessionId: "s-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, isOrgOwner),
    };
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
      ),
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) } },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OwnershipService,
        { provide: OwnershipTransferExpiryService, useValue: { expireStaleTransfers: jest.fn() } },
        OwnershipTransfersService,
        OwnershipTransferResponseService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            cached: jest.fn(),
            cachedVersioned: jest.fn(),
            cachedForOrg: jest.fn(),
            cachedVersionedForOrg: jest.fn(),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: OrganizationSagaService,
          useValue: {
            begin: jest.fn().mockResolvedValue({ saga: { sagaId: "saga-test" }, steps: [] }),
            runStep: jest
              .fn()
              .mockImplementation((_s, _n, fn) => fn()),
            complete: jest.fn().mockResolvedValue(undefined),
            compensate: jest.fn().mockResolvedValue(undefined),
          },
        },

      ],
    }).compile();
    ownership = moduleRef.get(OwnershipService);
    transfers = moduleRef.get(OwnershipTransfersService);
    responses = moduleRef.get(OwnershipTransferResponseService);
  });

  describe("initiateOrgTransfer", () => {
    it("throws ForbiddenException when actor is not a member of the org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        transfers.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws ForbiddenException when actor membership exists but isOwner is false", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select.mockReturnValue(makeSelectChain([actorMembership]));
      await expect(
        transfers.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws BadRequestException when actor tries to transfer to themselves", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: true, status: "ACTIVE" };
      mockDb.select.mockReturnValue(makeSelectChain([actorMembership]));
      await expect(
        transfers.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 1, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws NotFoundException when target membership does not exist in the org", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: true, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([]));
      await expect(
        transfers.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when target membership is not ACTIVE", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: true, status: "ACTIVE" };
      const targetMembership = { id: 2, userId: TARGET_USER, isOwner: false, status: "PENDING" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([targetMembership]));
      await expect(
        transfers.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("forceSetModuleOwner", () => {
    it("throws NotFoundException when target membership does not exist in the org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        ownership.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 99 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when target membership is not ACTIVE", async () => {
      const targetMembership = { id: 99, userId: TARGET_USER, isOwner: false, status: "PENDING" };
      mockDb.select.mockReturnValue(makeSelectChain([targetMembership]));
      await expect(
        ownership.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 99 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("returns { success: true } and runs inside a transaction when target is ACTIVE", async () => {
      const targetMembership = { id: 5, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const prevOwnership = { ownerMembershipId: 3 };
      const ownerRole = { id: 777 };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([targetMembership]))
        .mockReturnValueOnce(makeSelectChain([prevOwnership]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]));
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

      const result = await ownership.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 5 });

      expect(result).toMatchObject({ success: true });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("acceptTransfer", () => {
    const TRANSFER_ID = "tfr-abc-123";

    it("throws NotFoundException when transfer is not found for the given org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        responses.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when the transfer status is not PENDING", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        toMembershipId: 2,
        status: "ACCEPTED",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      mockDb.select.mockReturnValue(makeSelectChain([transfer]));
      await expect(
        responses.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws BadRequestException when the transfer has expired", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000),
      };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      await expect(
        responses.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws ForbiddenException when caller is not a member of the org", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([]));
      await expect(
        responses.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws ForbiddenException when caller membership id does not match toMembershipId", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      const actorMembership = { id: 99, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      await expect(
        responses.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("cancelTransfer", () => {
    const TRANSFER_ID = "tfr-cancel-456";

    it("throws NotFoundException when transfer does not exist for the given org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        responses.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, makeActor(false)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when the transfer is not in PENDING status", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        status: "CANCELLED",
        scope: "MODULE",
        moduleKey: "hr",
        toMembershipId: 2,
      };
      mockDb.select.mockReturnValue(makeSelectChain([transfer]));
      await expect(
        responses.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, makeActor(false)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws ForbiddenException when non-owner actor is not the transfer initiator", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        status: "PENDING",
        scope: "MODULE",
        moduleKey: "hr",
        toMembershipId: 2,
      };
      const actorMembership = { id: 99, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([]));
      await expect(
        responses.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, makeActor(false)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("org owner can cancel any transfer regardless of who initiated it", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        status: "PENDING",
        scope: "MODULE",
        moduleKey: "hr",
        toMembershipId: 2,
      };
      mockDb.select.mockReturnValue(makeSelectChain([transfer]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      await expect(
        responses.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, makeActor(true)),
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe("declineTransfer", () => {
    const TRANSFER_ID = "tfr-decline-789";

    it("throws ForbiddenException when caller is not the designated recipient", async () => {
      const transfer = {
        id: TRANSFER_ID,
        toMembershipId: 2,
        status: "PENDING",
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
      };
      const actorMembership = { id: 99, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      await expect(
        responses.declineTransfer(ORG, ACTOR_USER, TRANSFER_ID, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("acceptTransfer — MODULE scope role swap", () => {
    const TRANSFER_ID = "tfr-module-role-swap";
    const MODULE_KEY = "hr";
    const FROM_MEMBERSHIP_ID = 10;
    const TO_MEMBERSHIP_ID = 20;
    const OWNER_ROLE_ID = 888;

    function buildModuleTransfer() {
      return {
        id: TRANSFER_ID,
        scope: "MODULE" as const,
        moduleKey: MODULE_KEY,
        fromMembershipId: FROM_MEMBERSHIP_ID,
        initiatedByMembershipId: FROM_MEMBERSHIP_ID,
        toMembershipId: TO_MEMBERSHIP_ID,
        status: "PENDING" as const,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    }

    it("assigns MODULE_OWNER role to new owner and revokes it from old owner when transfer is accepted", async () => {
      const transfer = buildModuleTransfer();
      const recipientMembership = { id: TO_MEMBERSHIP_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: FROM_MEMBERSHIP_ID };
      const memberships = [
        { id: FROM_MEMBERSHIP_ID, userId: ACTOR_USER, status: "ACTIVE" },
        { id: TO_MEMBERSHIP_ID, userId: TARGET_USER, status: "ACTIVE" },
      ];
      const ownerRole = { id: OWNER_ROLE_ID };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain(memberships))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]));

      const deleteWhere = jest.fn().mockResolvedValue([]);
      mockDb.delete.mockReturnValue({ where: deleteWhere });
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      const result = await responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID);

      expect(result).toMatchObject({ success: true });
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(3);
    });

    it("throws BadRequestException when the MODULE_OWNER role is not seeded (prevents half-apply)", async () => {
      const transfer = buildModuleTransfer();
      const recipientMembership = { id: TO_MEMBERSHIP_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: FROM_MEMBERSHIP_ID };
      const memberships = [
        { id: FROM_MEMBERSHIP_ID, userId: ACTOR_USER, status: "ACTIVE" },
        { id: TO_MEMBERSHIP_ID, userId: TARGET_USER, status: "ACTIVE" },
      ];

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain(memberships))
        .mockReturnValueOnce(makeSelectChain([]));

      mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      await expect(
        responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("does not remove other role assignments from the previous owner during revoke", async () => {
      const transfer = buildModuleTransfer();
      const recipientMembership = { id: TO_MEMBERSHIP_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: FROM_MEMBERSHIP_ID };
      const memberships = [
        { id: FROM_MEMBERSHIP_ID, userId: ACTOR_USER, status: "ACTIVE" },
        { id: TO_MEMBERSHIP_ID, userId: TARGET_USER, status: "ACTIVE" },
      ];
      const ownerRole = { id: OWNER_ROLE_ID };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain(memberships))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]));

      const deleteWhere = jest.fn().mockResolvedValue([]);
      mockDb.delete.mockReturnValue({ where: deleteWhere });
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      await responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID);

      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("concurrent terminal transitions — conditional UPDATE prevents double-commit", () => {
    const TRANSFER_ID = "tfr-concurrent-test";

    it("declineTransfer throws ConflictException when UPDATE affects 0 rows (concurrent accept won)", async () => {
      const transfer = {
        id: TRANSFER_ID,
        toMembershipId: 2,
        status: "PENDING" as const,
        scope: "ORGANIZATION" as const,
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
      };
      const recipientMembership = { id: 2, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]));
      mockDb.update.mockReturnValue(makeUpdateChain([]));

      await expect(
        responses.declineTransfer(ORG, TARGET_USER, TRANSFER_ID, {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("cancelTransfer throws ConflictException when UPDATE affects 0 rows (concurrent accept won)", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        status: "PENDING" as const,
        scope: "MODULE" as const,
        moduleKey: "hr",
        toMembershipId: 2,
      };
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      mockDb.update.mockReturnValue(makeUpdateChain([]));

      await expect(
        responses.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, makeActor(false)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("declineTransfer succeeds (no conflict) when UPDATE affects 1 row", async () => {
      const transfer = {
        id: TRANSFER_ID,
        toMembershipId: 2,
        status: "PENDING" as const,
        scope: "ORGANIZATION" as const,
        moduleKey: null,
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
      };
      const recipientMembership = { id: 2, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValue(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]));
      mockDb.update.mockReturnValue(makeUpdateChain([{ id: TRANSFER_ID }]));

      await expect(
        responses.declineTransfer(ORG, TARGET_USER, TRANSFER_ID, {}),
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe("forceSetModuleOwner — role swap", () => {
    it("assigns MODULE_OWNER role to new owner when no previous ownership exists", async () => {
      const targetMembership = { id: 5, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const ownerRole = { id: 777 };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([targetMembership]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]));
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

      const result = await ownership.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 5 });

      expect(result).toMatchObject({ success: true });
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("does not revoke when previous owner is the same as the new owner", async () => {
      const targetMembership = { id: 5, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const prevOwnership = { ownerMembershipId: 5 };
      const ownerRole = { id: 777 };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([targetMembership]))
        .mockReturnValueOnce(makeSelectChain([prevOwnership]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]));
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

      const result = await ownership.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 5 });

      expect(result).toMatchObject({ success: true });
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });
});
