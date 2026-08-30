import { Test } from "@nestjs/testing";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OrganizationSagaService } from "../../organization/core/lifecycle/organization-saga.service";
import { OwnershipTransfersService } from "../ownership-transfers.service";
import { OwnershipTransferResponseService } from "../ownership-transfer-response.service";

const ORG = "org-a";
const OWNER_USER = "u-owner";
const RECIPIENT_USER = "u-recipient";
const TRANSFER_ID = "5f1c6f2e-1111-2222-3333-444455556666";

const OWNER_MEMBERSHIP = { id: 1, userId: OWNER_USER, isOwner: true, status: "ACTIVE" };
const RECIPIENT_MEMBERSHIP = { id: 2, userId: RECIPIENT_USER, isOwner: false, status: "ACTIVE" };

describe("Ownership transfer notifications", () => {
  const selectResults: unknown[][] = [];
  const emit = jest.fn();

  function nextSelectResult(): unknown[] {
    return selectResults.shift() ?? [];
  }

  /**
   * Drizzle chains terminate in different ways here: `.limit()`, `.for("update")`,
   * or a bare `await` on `.where()`. The chain is thenable so all three resolve.
   */
  function makeSelectChain() {
    const rows = nextSelectResult();
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      offset: jest.fn(),
      limit: jest.fn().mockResolvedValue(rows),
      for: jest.fn().mockResolvedValue(rows),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.offset.mockReturnValue(chain);
    return chain;
  }

  interface MockDb {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  }

  const db: MockDb = {
    select: jest.fn().mockImplementation(makeSelectChain),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: TRANSFER_ID, expiresAt: new Date() }]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: TRANSFER_ID }]),
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
        }),
      }),
    }),
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
  };

  let transfers: OwnershipTransfersService;
  let responses: OwnershipTransferResponseService;

  beforeEach(async () => {
    jest.clearAllMocks();
    selectResults.length = 0;
    emit.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OwnershipTransfersService,
        OwnershipTransferResponseService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit } },
        {
          provide: OrganizationSagaService,
          useValue: {
            begin: jest
              .fn()
              .mockResolvedValue({ saga: { sagaId: "saga-notif" }, steps: [] }),
            runStep: jest
              .fn()
              .mockImplementation(
                (_sagaId: string, _step: string, fn: () => Promise<unknown>) => fn(),
              ),
            complete: jest.fn().mockResolvedValue(undefined),
            compensate: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    transfers = moduleRef.get(OwnershipTransfersService);
    responses = moduleRef.get(OwnershipTransferResponseService);
  });

  async function flushPendingNotifications(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("notifies the nominee when an org transfer is initiated", async () => {
    selectResults.push([OWNER_MEMBERSHIP], [RECIPIENT_MEMBERSHIP]);

    await transfers.initiateOrgTransfer(ORG, OWNER_USER, {
      toMembershipId: RECIPIENT_MEMBERSHIP.id,
      expiresInHours: 48,
    });
    await flushPendingNotifications();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "ownership.transfer.requested",
        orgId: ORG,
        targetUserIds: [RECIPIENT_USER],
        link: "/settings/incoming-transfer",
      }),
    );
  });

  it("notifies the initiator when the nominee declines", async () => {
    selectResults.push(
      [
        {
          id: TRANSFER_ID,
          toMembershipId: RECIPIENT_MEMBERSHIP.id,
          status: "PENDING",
          scope: "ORGANIZATION",
          moduleKey: null,
          fromMembershipId: OWNER_MEMBERSHIP.id,
        },
      ],
      [RECIPIENT_MEMBERSHIP],
      [{ userId: OWNER_USER }],
    );

    await responses.declineTransfer(ORG, RECIPIENT_USER, TRANSFER_ID, {
      reason: "Not my call to make",
    });
    await flushPendingNotifications();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "ownership.transfer.declined",
        orgId: ORG,
        targetUserIds: [OWNER_USER],
        message: expect.stringContaining("Not my call to make"),
      }),
    );
  });

  it("still completes the transfer request when notification dispatch fails", async () => {
    selectResults.push([OWNER_MEMBERSHIP], [RECIPIENT_MEMBERSHIP]);
    emit.mockRejectedValue(new Error("dispatch down"));

    await expect(
      transfers.initiateOrgTransfer(ORG, OWNER_USER, {
        toMembershipId: RECIPIENT_MEMBERSHIP.id,
        expiresInHours: 48,
      }),
    ).resolves.toEqual(expect.objectContaining({ transferId: TRANSFER_ID }));
    await flushPendingNotifications();
  });
});
