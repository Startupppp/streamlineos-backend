import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
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
  leftJoin: jest.Mock;
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
    leftJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    orderBy: jest.fn(),
    for: jest.fn().mockResolvedValue(result),
    returning: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  (chain as unknown as Record<string, unknown>)["then"] = (
    resolve: (v: unknown[]) => unknown,
  ) => Promise.resolve(result).then(resolve);
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

const ORG = "org-transfer-parties-test";

const ORG_OWNER_USER = "u-org-owner";
const MODULE_OWNER_USER = "u-module-owner";
const TARGET_USER = "u-target";
const UNRELATED_USER = "u-unrelated";

const ORG_OWNER_MEMBER_ID = 1;
const MODULE_OWNER_MEMBER_ID = 5;
const TARGET_MEMBER_ID = 10;
const UNRELATED_MEMBER_ID = 99;

const MODULE_KEY = "hr";
const TRANSFER_ID = "tfr-parties-001";

function makeActor(userId: string, membershipId: number, isOrgOwner: boolean): CurrentUserContext {
  return {
    orgId: ORG,
    userId,
    role: isOrgOwner ? "OWNER" : "MEMBER",
    isOrgOwner,
    sessionId: "sess-test",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, isOrgOwner),
  };
}

const orgOwnerActor = makeActor(ORG_OWNER_USER, ORG_OWNER_MEMBER_ID, true);
const moduleOwnerActor = makeActor(MODULE_OWNER_USER, MODULE_OWNER_MEMBER_ID, false);
const unrelatedActor = makeActor(UNRELATED_USER, UNRELATED_MEMBER_ID, false);

describe("module transfer — three-party scenario (from ≠ initiator)", () => {
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
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
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
            cachedVersionedForOrg: jest.fn().mockResolvedValue(undefined),
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

    transfers = moduleRef.get(OwnershipTransfersService);
    responses = moduleRef.get(OwnershipTransferResponseService);
  });

  describe("initiateModuleTransfer — fromMembershipId assignment", () => {
    it("(regression) org owner initiating for a module they do not own sets fromMembershipId to the current module owner", async () => {
      const actorMembership = { id: ORG_OWNER_MEMBER_ID, userId: ORG_OWNER_USER, isOwner: true, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: MODULE_OWNER_MEMBER_ID };
      const target = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain([target]));

      const insertChain = makeInsertChain([{ id: TRANSFER_ID, expiresAt: new Date(Date.now() + 3_600_000) }]);
      mockDb.insert.mockReturnValue(insertChain);

      const result = await transfers.initiateModuleTransfer(
        ORG,
        ORG_OWNER_USER,
        MODULE_KEY,
        { toMembershipId: TARGET_MEMBER_ID, expiresInHours: 48 },
        orgOwnerActor,
      );

      expect(result).toMatchObject({ transferId: TRANSFER_ID });
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          fromMembershipId: MODULE_OWNER_MEMBER_ID,
          initiatedByMembershipId: ORG_OWNER_MEMBER_ID,
          toMembershipId: TARGET_MEMBER_ID,
        }),
      );
    });

    it("module owner initiating their own transfer sets both fromMembershipId and initiatedByMembershipId to themselves", async () => {
      const actorMembership = { id: MODULE_OWNER_MEMBER_ID, userId: MODULE_OWNER_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: MODULE_OWNER_MEMBER_ID };
      const ownershipForCheck = { userId: MODULE_OWNER_USER };
      const target = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain([ownershipForCheck]))
        .mockReturnValueOnce(makeSelectChain([target]));

      const insertChain = makeInsertChain([{ id: TRANSFER_ID, expiresAt: new Date(Date.now() + 3_600_000) }]);
      mockDb.insert.mockReturnValue(insertChain);

      await transfers.initiateModuleTransfer(
        ORG,
        MODULE_OWNER_USER,
        MODULE_KEY,
        { toMembershipId: TARGET_MEMBER_ID, expiresInHours: 48 },
        moduleOwnerActor,
      );

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          fromMembershipId: MODULE_OWNER_MEMBER_ID,
          initiatedByMembershipId: MODULE_OWNER_MEMBER_ID,
          toMembershipId: TARGET_MEMBER_ID,
        }),
      );
    });

    it("throws NotFoundException when there is no module ownership record, even for an org owner", async () => {
      const actorMembership = { id: ORG_OWNER_MEMBER_ID, userId: ORG_OWNER_USER, isOwner: true, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([]));

      await expect(
        transfers.initiateModuleTransfer(ORG, ORG_OWNER_USER, MODULE_KEY, { toMembershipId: TARGET_MEMBER_ID, expiresInHours: 48 }, orgOwnerActor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws ForbiddenException when a plain member is not the current module owner", async () => {
      const actorMembership = { id: UNRELATED_MEMBER_ID, userId: UNRELATED_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: MODULE_OWNER_MEMBER_ID };
      const ownershipForCheck = { userId: MODULE_OWNER_USER };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain([ownershipForCheck]));

      await expect(
        transfers.initiateModuleTransfer(ORG, UNRELATED_USER, MODULE_KEY, { toMembershipId: TARGET_MEMBER_ID, expiresInHours: 48 }, unrelatedActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws BadRequestException when the target is already the current module owner (no-op transfer)", async () => {
      const actorMembership = { id: ORG_OWNER_MEMBER_ID, userId: ORG_OWNER_USER, isOwner: true, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: MODULE_OWNER_MEMBER_ID };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]));

      await expect(
        transfers.initiateModuleTransfer(
          ORG,
          ORG_OWNER_USER,
          MODULE_KEY,
          { toMembershipId: MODULE_OWNER_MEMBER_ID, expiresInHours: 48 },
          orgOwnerActor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("acceptTransfer — MODULE scope with org-owner initiator", () => {
    function buildTransfer(overrides: Partial<{
      fromMembershipId: number;
      initiatedByMembershipId: number;
      toMembershipId: number;
      status: string;
      expiresAt: Date;
    }> = {}) {
      return {
        id: TRANSFER_ID,
        scope: "MODULE" as const,
        moduleKey: MODULE_KEY,
        fromMembershipId: MODULE_OWNER_MEMBER_ID,
        initiatedByMembershipId: ORG_OWNER_MEMBER_ID,
        toMembershipId: TARGET_MEMBER_ID,
        status: "PENDING" as const,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...overrides,
      };
    }

    it("(regression) acceptance succeeds when the initiator is an org owner who is not the module owner", async () => {
      const transfer = buildTransfer();
      const recipientMembership = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: MODULE_OWNER_MEMBER_ID };
      const memberships = [
        { id: MODULE_OWNER_MEMBER_ID, userId: MODULE_OWNER_USER, status: "ACTIVE" },
        { id: TARGET_MEMBER_ID, userId: TARGET_USER, status: "ACTIVE" },
      ];
      const ownerRole = { id: 777 };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain(memberships))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([{ userId: MODULE_OWNER_USER }]));

      mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      const result = await responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID);

      expect(result).toMatchObject({ success: true });
    });

    it("acceptance succeeds when the module owner initiates their own transfer (fromMembershipId = initiatedByMembershipId)", async () => {
      const transfer = buildTransfer({
        fromMembershipId: MODULE_OWNER_MEMBER_ID,
        initiatedByMembershipId: MODULE_OWNER_MEMBER_ID,
      });
      const recipientMembership = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const currentOwnership = { ownerMembershipId: MODULE_OWNER_MEMBER_ID };
      const memberships = [
        { id: MODULE_OWNER_MEMBER_ID, userId: MODULE_OWNER_USER, status: "ACTIVE" },
        { id: TARGET_MEMBER_ID, userId: TARGET_USER, status: "ACTIVE" },
      ];
      const ownerRole = { id: 777 };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([currentOwnership]))
        .mockReturnValueOnce(makeSelectChain(memberships))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([ownerRole]))
        .mockReturnValueOnce(makeSelectChain([{ userId: MODULE_OWNER_USER }]));

      mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
      mockDb.insert.mockReturnValue(makeInsertChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      const result = await responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID);

      expect(result).toMatchObject({ success: true });
    });

    it("acceptance fails with a descriptive message when ownership moved between initiation and acceptance", async () => {
      const transfer = buildTransfer({ fromMembershipId: MODULE_OWNER_MEMBER_ID });
      const recipientMembership = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const differentOwnership = { ownerMembershipId: UNRELATED_MEMBER_ID };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([differentOwnership]));

      mockDb.update.mockReturnValue(makeUpdateChain());

      await expect(
        responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID),
      ).rejects.toThrow("Module ownership changed since this transfer was initiated");
    });

    it("acceptance fails when ownership record is missing at apply time", async () => {
      const transfer = buildTransfer();
      const recipientMembership = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([]));

      mockDb.update.mockReturnValue(makeUpdateChain());

      await expect(
        responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("second transfer for the same module fails expected-owner check after the first was accepted", async () => {
      const secondTransfer = buildTransfer({
        fromMembershipId: MODULE_OWNER_MEMBER_ID,
      });
      const recipientMembership = { id: TARGET_MEMBER_ID, userId: TARGET_USER, isOwner: false, status: "ACTIVE" };
      const ownershipAfterFirstAcceptance = { ownerMembershipId: TARGET_MEMBER_ID };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([secondTransfer]))
        .mockReturnValueOnce(makeSelectChain([recipientMembership]))
        .mockReturnValueOnce(makeSelectChain([ownershipAfterFirstAcceptance]));

      mockDb.update.mockReturnValue(makeUpdateChain());

      await expect(
        responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID),
      ).rejects.toThrow("Module ownership changed since this transfer was initiated");
    });

    it("expired transfer cannot be accepted", async () => {
      const expiredTransfer = buildTransfer({
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000),
      });

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([expiredTransfer]))
        .mockReturnValueOnce(makeSelectChain([]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      await expect(
        responses.acceptTransfer(ORG, TARGET_USER, TRANSFER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("cancelTransfer — initiator is org owner, not the current module owner", () => {
    function buildCancelTransfer(overrides: Partial<{
      initiatedByMembershipId: number;
      fromMembershipId: number;
    }> = {}) {
      return {
        id: TRANSFER_ID,
        fromMembershipId: MODULE_OWNER_MEMBER_ID,
        initiatedByMembershipId: ORG_OWNER_MEMBER_ID,
        status: "PENDING" as const,
        scope: "MODULE" as const,
        moduleKey: MODULE_KEY,
        toMembershipId: TARGET_MEMBER_ID,
        ...overrides,
      };
    }

    it("the initiator (org owner who started the transfer) may cancel even though they are not the module owner", async () => {
      const transfer = buildCancelTransfer();
      const actorMembership = { id: ORG_OWNER_MEMBER_ID, userId: ORG_OWNER_USER, isOwner: true, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([{ userId: TARGET_USER }]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      const result = await responses.cancelTransfer(ORG, ORG_OWNER_USER, TRANSFER_ID, orgOwnerActor);

      expect(result).toMatchObject({ success: true });
    });

    it("an org owner may cancel any transfer regardless of who initiated it", async () => {
      const transfer = buildCancelTransfer({ initiatedByMembershipId: UNRELATED_MEMBER_ID });
      const actorMembership = { id: ORG_OWNER_MEMBER_ID, userId: ORG_OWNER_USER, isOwner: true, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([{ userId: TARGET_USER }]));
      mockDb.update.mockReturnValue(makeUpdateChain());

      const result = await responses.cancelTransfer(ORG, ORG_OWNER_USER, TRANSFER_ID, orgOwnerActor);

      expect(result).toMatchObject({ success: true });
    });

    it("an unrelated plain member who is not the initiator cannot cancel", async () => {
      const transfer = buildCancelTransfer();
      const actorMembership = { id: UNRELATED_MEMBER_ID, userId: UNRELATED_USER, isOwner: false, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]))
        .mockReturnValueOnce(makeSelectChain([{ userId: MODULE_OWNER_USER }]));

      await expect(
        responses.cancelTransfer(ORG, UNRELATED_USER, TRANSFER_ID, unrelatedActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws ConflictException when the conditional UPDATE affects 0 rows (concurrent accept won)", async () => {
      const transfer = buildCancelTransfer();
      const actorMembership = { id: ORG_OWNER_MEMBER_ID, userId: ORG_OWNER_USER, isOwner: true, status: "ACTIVE" };

      mockDb.select
        .mockReturnValueOnce(makeSelectChain([transfer]))
        .mockReturnValueOnce(makeSelectChain([actorMembership]));
      mockDb.update.mockReturnValue(makeUpdateChain([]));

      await expect(
        responses.cancelTransfer(ORG, ORG_OWNER_USER, TRANSFER_ID, orgOwnerActor),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
