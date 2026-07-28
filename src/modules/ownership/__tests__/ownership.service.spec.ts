import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OwnershipService } from "../ownership.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";

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
    for: jest.fn(),
    returning: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.for.mockReturnValue(chain);
  return chain;
}

type UpdateChain = {
  set: jest.Mock;
  where: jest.Mock;
};

function makeUpdateChain(): UpdateChain {
  const chain: UpdateChain = { set: jest.fn(), where: jest.fn().mockResolvedValue([]) };
  chain.set.mockReturnValue(chain);
  return chain;
}

type InsertChain = {
  values: jest.Mock;
  returning: jest.Mock;
  onConflictDoUpdate: jest.Mock;
};

function makeInsertChain(result: unknown[]): InsertChain {
  const chain: InsertChain = {
    values: jest.fn(),
    returning: jest.fn().mockResolvedValue(result),
    onConflictDoUpdate: jest.fn(),
  };
  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockReturnValue(chain);
  return chain;
}

describe("OwnershipService — access / business-rule logic", () => {
  let svc: OwnershipService;
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  };

  const ORG = "org-unit-test";
  const ACTOR_USER = "u-actor";
  const TARGET_USER = "u-target";

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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OwnershipService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
      ],
    }).compile();
    svc = moduleRef.get(OwnershipService);
  });

  describe("initiateOrgTransfer", () => {
    it("throws ForbiddenException when actor is not a member of the org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        svc.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws ForbiddenException when actor membership exists but isOwner is false", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select.mockReturnValue(makeSelectChain([actorMembership]));
      await expect(
        svc.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws BadRequestException when actor tries to transfer to themselves", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: true, status: "ACTIVE" };
      mockDb.select.mockReturnValue(makeSelectChain([actorMembership]));
      await expect(
        svc.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 1, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws NotFoundException when target membership does not exist in the org", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: true, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([]));
      await expect(
        svc.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when target membership is not ACTIVE", async () => {
      const actorMembership = { id: 1, userId: ACTOR_USER, isOwner: true, status: "ACTIVE" };
      const targetMembership = { id: 2, userId: TARGET_USER, isOwner: false, status: "PENDING" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([targetMembership]));
      await expect(
        svc.initiateOrgTransfer(ORG, ACTOR_USER, { toMembershipId: 2, expiresInHours: 48 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("forceSetModuleOwner", () => {
    it("throws NotFoundException when target membership does not exist in the org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        svc.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 99 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when target membership is not ACTIVE", async () => {
      const targetMembership = { id: 99, userId: TARGET_USER, isOwner: false, status: "PENDING" };
      mockDb.select.mockReturnValue(makeSelectChain([targetMembership]));
      await expect(
        svc.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 99 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("returns { success: true } and runs inside a transaction when target is ACTIVE", async () => {
      const targetMembership = { id: 5, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select.mockReturnValue(makeSelectChain([targetMembership]));
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      const result = await svc.forceSetModuleOwner(ORG, ACTOR_USER, "hr", { ownerMembershipId: 5 });

      expect(result).toMatchObject({ success: true });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("acceptTransfer", () => {
    const TRANSFER_ID = "tfr-abc-123";

    it("throws NotFoundException when transfer is not found for the given org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        svc.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when the transfer status is not PENDING", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        toMembershipId: 2,
        status: "ACCEPTED",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      mockDb.select.mockReturnValue(makeSelectChain([transfer]));
      await expect(
        svc.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws BadRequestException when the transfer has expired", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000),
      };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      await expect(
        svc.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws ForbiddenException when caller is not a member of the org", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([]));
      await expect(
        svc.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws ForbiddenException when caller membership id does not match toMembershipId", async () => {
      const transfer = {
        id: TRANSFER_ID,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      const actorMembership = { id: 99, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      await expect(
        svc.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("cancelTransfer", () => {
    const TRANSFER_ID = "tfr-cancel-456";

    it("throws NotFoundException when transfer does not exist for the given org", async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));
      await expect(
        svc.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when the transfer is not in PENDING status", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        status: "CANCELLED",
        scope: "MODULE",
        moduleKey: "hr",
        toMembershipId: 2,
      };
      mockDb.select.mockReturnValue(makeSelectChain([transfer]));
      await expect(
        svc.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, false),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws ForbiddenException when non-owner actor is not the transfer initiator", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        status: "PENDING",
        scope: "MODULE",
        moduleKey: "hr",
        toMembershipId: 2,
      };
      const actorMembership = { id: 99, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      await expect(
        svc.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, false),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("org owner can cancel any transfer regardless of who initiated it", async () => {
      const transfer = {
        id: TRANSFER_ID,
        fromMembershipId: 1,
        status: "PENDING",
        scope: "MODULE",
        moduleKey: "hr",
        toMembershipId: 2,
      };
      mockDb.select.mockReturnValue(makeSelectChain([transfer]));
      mockDb.update.mockReturnValue(makeUpdateChain());
      await expect(
        svc.cancelTransfer(ORG, ACTOR_USER, TRANSFER_ID, true),
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
      };
      const actorMembership = { id: 99, userId: ACTOR_USER, isOwner: false, status: "ACTIVE" };
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      await expect(
        svc.declineTransfer(ORG, ACTOR_USER, TRANSFER_ID, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
