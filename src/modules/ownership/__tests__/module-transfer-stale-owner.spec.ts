import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OwnershipTransferResponseService } from "../ownership-transfer-response.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
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
  for: jest.Mock;
};

function makeSelectChain(result: unknown[]): SelectChain {
  const chain: SelectChain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    for: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

type UpdateChain = { set: jest.Mock; where: jest.Mock; returning: jest.Mock };

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

type InsertChain = { values: jest.Mock; onConflictDoUpdate: jest.Mock };

function makeInsertChain(): InsertChain {
  const chain: InsertChain = {
    values: jest.fn(),
    onConflictDoUpdate: jest.fn().mockResolvedValue([]),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

const ORG = "org-stale-test";
const MODULE_KEY = "hr";
const TRANSFER_ID = "tfr-stale-001";

const FROM_MEMBER_ID = 10;
const TO_MEMBER_ID = 20;
const DIFFERENT_OWNER_ID = 99;

const FROM_USER = "u-from";
const TO_USER = "u-to";

async function buildService(mockDb: object) {
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
      {
        provide: NotificationDispatchService,
        useValue: { emit: jest.fn().mockResolvedValue(undefined) },
      },
      {
        provide: OrganizationSagaService,
        useValue: {
          begin: jest.fn().mockResolvedValue({
            saga: { sagaId: "saga-stale" },
            steps: [],
          }),
          runStep: jest.fn().mockImplementation(
            (_sid: string, _step: string, fn: () => Promise<unknown>) => fn(),
          ),
          complete: jest.fn().mockResolvedValue(undefined),
          compensate: jest.fn().mockResolvedValue(undefined),
        },
      },
    ],
  }).compile();

  return moduleRef.get(OwnershipTransferResponseService);
}

describe("applyModuleTransfer — stale-owner detection", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(bustMembershipStatusCache).mockResolvedValue(undefined as never);
    jest.mocked(syncStructuralRoleAssignment).mockResolvedValue(undefined);
    jest.mocked(commitAccessChange).mockResolvedValue(undefined);
    jest.mocked(revokeModuleOwnerRole).mockResolvedValue(undefined);
    jest.mocked(assertModuleOwnerRoleAssigned).mockResolvedValue(undefined);
  });

  const pendingModuleTransfer = {
    id: TRANSFER_ID,
    scope: "MODULE" as const,
    moduleKey: MODULE_KEY,
    fromMembershipId: FROM_MEMBER_ID,
    initiatedByMembershipId: FROM_MEMBER_ID,
    toMembershipId: TO_MEMBER_ID,
    status: "PENDING" as const,
    expiresAt: new Date(Date.now() + 3_600_000),
  };

  const recipient = { id: TO_MEMBER_ID, userId: TO_USER, isOwner: false, status: "ACTIVE" };

  it("d) rejects with BadRequest when the current ownerMembershipId differs from fromMembershipId", async () => {
    const mockDb = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([pendingModuleTransfer]))
        .mockReturnValueOnce(makeSelectChain([recipient])),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
      insert: jest.fn(),
      transaction: jest.fn(),
    };

    const staleTxMock = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ ownerMembershipId: DIFFERENT_OWNER_ID }])),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };

    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof staleTxMock) => Promise<unknown>) => fn(staleTxMock),
    );

    const service = await buildService(mockDb);

    const err = await service.acceptTransfer(ORG, TO_USER, TRANSFER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toMatch(
      "Module ownership changed since this transfer was initiated",
    );
  });

  it("e) throws ConflictException when the conditional PENDING UPDATE returns 0 rows", async () => {
    const fromMember = { id: FROM_MEMBER_ID, userId: FROM_USER, status: "ACTIVE" };
    const toMember = { id: TO_MEMBER_ID, userId: TO_USER, status: "ACTIVE" };

    const mockDb = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([pendingModuleTransfer]))
        .mockReturnValueOnce(makeSelectChain([recipient])),
      update: jest.fn(),
      insert: jest.fn(),
      transaction: jest.fn(),
    };

    const concurrentTxMock = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ ownerMembershipId: FROM_MEMBER_ID }]))
        .mockReturnValueOnce(makeSelectChain([fromMember, toMember])),
      insert: jest.fn().mockReturnValue(makeInsertChain()),
      update: jest.fn().mockReturnValue(makeUpdateChain([])),
    };

    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof concurrentTxMock) => Promise<unknown>) => fn(concurrentTxMock),
    );

    const service = await buildService(mockDb);

    await expect(
      service.acceptTransfer(ORG, TO_USER, TRANSFER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("applyOrgTransfer — stale-owner detection", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(bustMembershipStatusCache).mockResolvedValue(undefined as never);
    jest.mocked(syncStructuralRoleAssignment).mockResolvedValue(undefined);
    jest.mocked(commitAccessChange).mockResolvedValue(undefined);
    jest.mocked(revokeModuleOwnerRole).mockResolvedValue(undefined);
    jest.mocked(assertModuleOwnerRoleAssigned).mockResolvedValue(undefined);
  });

  it("f) rejects when the from membership is no longer the org owner", async () => {
    const pendingOrgTransfer = {
      id: TRANSFER_ID,
      scope: "ORGANIZATION" as const,
      moduleKey: null,
      fromMembershipId: FROM_MEMBER_ID,
      initiatedByMembershipId: FROM_MEMBER_ID,
      toMembershipId: TO_MEMBER_ID,
      status: "PENDING" as const,
      expiresAt: new Date(Date.now() + 3_600_000),
    };

    const recipientForOrg = {
      id: TO_MEMBER_ID,
      userId: TO_USER,
      isOwner: false,
      status: "ACTIVE",
    };

    const mockDb = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([pendingOrgTransfer]))
        .mockReturnValueOnce(makeSelectChain([recipientForOrg])),
      update: jest.fn(),
      insert: jest.fn(),
      transaction: jest.fn(),
    };

    jest.mocked(runInTenantTransaction).mockImplementation(
      async (_db, fn) => {
        const tenantTx = {
          select: jest.fn()
            .mockReturnValueOnce(makeSelectChain([{ statusV2: "ACTIVE" }]))
            .mockReturnValueOnce(makeSelectChain([])),
        };
        return fn(tenantTx as never);
      },
    );

    const staleOrgTxMock = {
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ ownerMembershipId: DIFFERENT_OWNER_ID }]))
        .mockReturnValueOnce(makeSelectChain([
          { id: FROM_MEMBER_ID, userId: FROM_USER, isOwner: false, status: "ACTIVE" },
          { id: TO_MEMBER_ID, userId: TO_USER, isOwner: false, status: "ACTIVE" },
        ])),
      update: jest.fn().mockReturnValue(makeUpdateChain([{ id: TRANSFER_ID }])),
    };

    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof staleOrgTxMock) => Promise<unknown>) => fn(staleOrgTxMock),
    );

    const service = await buildService(mockDb);

    const err = await service.acceptTransfer(ORG, TO_USER, TRANSFER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toMatch("Organization ownership changed");
  });
});
