import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OwnershipTransferResponseService } from "../ownership-transfer-response.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { assertTransitionAllowed } from "../../organization/core/lifecycle/organization-lifecycle-transitions";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { commitAccessChange } from "../../../common/rbac/access-mutation-commit";
import { revokeModuleOwnerRole, assertModuleOwnerRoleAssigned } from "../module-owner-role.helper";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OrganizationSagaService } from "../../organization/core/lifecycle/organization-saga.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction");
jest.mock("../../../common/auth/membership-state.service");
jest.mock("../../../common/rbac/sync-structural-role");
jest.mock("../../../common/rbac/access-mutation-commit");
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

/**
 * The lifecycle gate reads two rows and nothing else, so the double supplies
 * only `select`.
 *
 * Every one of the seven call sites used to widen this with `as any` at the
 * point of use. `runInTenantTransaction`'s callback takes a full Drizzle
 * `TenantTx` — a structural type with dozens of methods — so a two-row double
 * can never be assignable to it and some widening is unavoidable. What is
 * avoidable is doing it seven times, in `any`, where nothing checks that the
 * double still spells `select` the way the service calls it. Annotating the
 * slice checks the name once and returns the type the callback actually wants,
 * so the call sites need no cast at all.
 */
type TxDouble = Pick<TenantTx, "select">;

function makeTenantTx(statusV2: string | null, hasHold: boolean): TenantTx {
  const double: TxDouble = {
    select: jest.fn()
      .mockReturnValueOnce(makeSelectChain([{ statusV2 }]))
      .mockReturnValueOnce(makeSelectChain(hasHold ? [{ holdId: "hold-1" }] : [])),
  };
  return double as unknown as TenantTx;
}

describe("OwnershipTransferResponseService — OWNERSHIP_TRANSFER lifecycle gate", () => {
  let service: OwnershipTransferResponseService;
  let mockDb: {
    select: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
    transaction: jest.Mock;
  };
  let sagaBegin: jest.Mock;
  let sagaRunStep: jest.Mock;
  let sagaComplete: jest.Mock;
  let sagaCompensate: jest.Mock;

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
    jest.mocked(commitAccessChange).mockImplementation(() => Promise.resolve());
    jest.mocked(revokeModuleOwnerRole).mockImplementation(() => Promise.resolve());
    jest.mocked(assertModuleOwnerRoleAssigned).mockImplementation(() => Promise.resolve());

    sagaBegin = jest.fn().mockResolvedValue({
      saga: { sagaId: "test-saga-ownership" },
      steps: [],
    });
    sagaRunStep = jest.fn().mockImplementation(
      (_sagaId: string, _stepName: string, fn: () => Promise<unknown>) => fn(),
    );
    sagaComplete = jest.fn().mockResolvedValue(undefined);
    sagaCompensate = jest.fn().mockResolvedValue(undefined);

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
        {
          provide: OrganizationSagaService,
          useValue: {
            begin: sagaBegin,
            runStep: sagaRunStep,
            complete: sagaComplete,
            compensate: sagaCompensate,
          },
        },
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
    it("is NOT blocked by an active legal hold, which only refuses destructive transitions", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", true)),
      );
      setupOrgTransferTx();

      await expect(
        service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID),
      ).resolves.toBeDefined();

      expect(jest.mocked(runInTenantTransaction)).toHaveBeenCalledTimes(1);
    });

    it("still refuses the destructive transitions a hold does block", () => {
      expect(
        assertTransitionAllowed("TERMINAL_DELETE", "ACTIVE", {
          hasActiveLegalHold: true,
        }).allowed,
      ).toBe(false);
      expect(
        assertTransitionAllowed("PURGE_SCHEDULE", "ACTIVE", {
          hasActiveLegalHold: true,
        }).allowed,
      ).toBe(false);
      expect(
        assertTransitionAllowed("OWNERSHIP_TRANSFER", "ACTIVE", {
          hasActiveLegalHold: true,
        }).allowed,
      ).toBe(true);
    });

    it("throws BadRequestException when the org statusV2 disallows the OWNERSHIP_TRANSFER transition", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ARCHIVED", false)),
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
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false)),
      );
      setupOrgTransferTx();

      const result = await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(result).toEqual({ success: true });
      expect(jest.mocked(runInTenantTransaction)).toHaveBeenCalledTimes(1);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("ORGANIZATION transfer moves both parties' rights on one transaction handle", () => {
    it("demotes the outgoing owner, promotes the incoming one and bumps the version on the same handle", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false)),
      );
      const txMock = setupOrgTransferTx();

      await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(syncStructuralRoleAssignment).toHaveBeenCalledTimes(2);
      expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(txMock, ORG, 1, "ORG_ADMIN");
      expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(txMock, ORG, 2, "OWNER");
      expect(commitAccessChange).toHaveBeenCalledWith(txMock, ORG);
    });

    it("writes the owner_membership_id repoint and the transfer's ACCEPTED stamp on that same handle", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false)),
      );
      const txMock = setupOrgTransferTx();

      await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(txMock.update).toHaveBeenCalledTimes(4);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("MODULE transfer moves the ownership expansion on one transaction handle", () => {
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

    it("revokes the outgoing owner's role and grants the incoming one's beside the bump, all on the same handle", async () => {
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

      await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(txMock.insert).toHaveBeenCalledTimes(1);
      expect(revokeModuleOwnerRole).toHaveBeenCalledWith(txMock, ORG, "hr", 1);
      expect(assertModuleOwnerRoleAssigned).toHaveBeenCalledWith(txMock, ORG, "hr", 2);
      expect(commitAccessChange).toHaveBeenCalledWith(txMock, ORG);
    });

    it("leaves the org's structural roles untouched — a module handover is not an org handover", async () => {
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

      await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(syncStructuralRoleAssignment).not.toHaveBeenCalled();
      expect(assertModuleOwnerRoleAssigned).toHaveBeenCalledTimes(1);
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
      expect(sagaBegin).not.toHaveBeenCalled();
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("legal-hold read happens inside a tenant transaction, not on the pool", () => {
    it("calls runInTenantTransaction with the correct orgId and invokes the callback", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ARCHIVED", true)),
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

  describe("OWNERSHIP_TRANSFER saga wiring", () => {
    it("org transfer: retry skips validate-new-owner when already DONE", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false)),
      );
      setupOrgTransferTx();

      sagaBegin.mockResolvedValueOnce({
        saga: { sagaId: "resume-ownership-1" },
        steps: [
          { stepName: "validate-new-owner", state: "DONE" },
          { stepName: "transfer-ownership", state: "PENDING" },
        ],
      });

      await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      const runStepCalls = sagaRunStep.mock.calls.map((c) => c[1] as string);
      expect(runStepCalls).not.toContain("validate-new-owner");
      expect(runStepCalls).toContain("transfer-ownership");
    });

    it("org transfer: failure in transfer-ownership calls compensate and rethrows", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false)),
      );

      const boom = new Error("transfer failed");
      sagaRunStep.mockImplementation(
        (_sagaId: string, stepName: string, fn: () => Promise<unknown>) => {
          if (stepName === "transfer-ownership") throw boom;
          return fn();
        },
      );

      await expect(service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID)).rejects.toBe(boom);
      expect(sagaCompensate).toHaveBeenCalledWith("test-saga-ownership", {});
    });

    it("org transfer: saga begin is called with org-scoped transfer requestKey", async () => {
      setupCommonDbMocks();
      jest.mocked(runInTenantTransaction).mockImplementation(
        async (_db, fn) => fn(makeTenantTx("ACTIVE", false)),
      );
      setupOrgTransferTx();

      await service.acceptTransfer(ORG, ACTOR_USER, TRANSFER_ID);

      expect(sagaBegin).toHaveBeenCalledWith(
        "OWNERSHIP_TRANSFER",
        ORG,
        `ownership-transfer:${ORG}:${TRANSFER_ID}`,
        ACTOR_USER,
        "ACTIVE",
      );
    });

    it("MODULE-scoped transfer still bypasses the org saga entirely", async () => {
      const pendingModuleTransfer = {
        id: TRANSFER_ID,
        scope: "MODULE" as const,
        moduleKey: "crm",
        fromMembershipId: 1,
        initiatedByMembershipId: 1,
        toMembershipId: 2,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 3_600_000),
      };

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
      expect(sagaBegin).not.toHaveBeenCalled();
      expect(sagaRunStep).not.toHaveBeenCalled();
      expect(jest.mocked(runInTenantTransaction)).not.toHaveBeenCalled();
    });
  });
});
