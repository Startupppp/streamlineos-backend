jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";

const ORG_ID = "org-resend-seat";
const ACTOR = { userId: "actor-1", isOrgOwner: true };
const INVITATION_ID = "inv-resend-seat-1";
const PAST_DATE = new Date(Date.now() - 86_400_000);
const FUTURE_DATE = new Date(Date.now() + 86_400_000);

const BASE_INVITATION = {
  id: INVITATION_ID,
  orgId: ORG_ID,
  email: "invitee@example.com",
  status: "PENDING" as const,
  acceptedAt: null,
  expiresAt: FUTURE_DATE,
};

function buildQuery() {
  return {
    invitations: { findFirst: jest.fn().mockResolvedValue(BASE_INVITATION) },
    organizations: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORG_ID,
        name: "Acme",
        status: "ACTIVE",
        deletedAt: null,
      }),
    },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
    users: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

function buildUniversalTx(query: ReturnType<typeof buildQuery>) {
  const updateResult = {
    returning: jest.fn().mockResolvedValue([{ id: INVITATION_ID }]),
  };
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    query,
    select: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    for: jest.fn(),
    limit: jest.fn().mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: FUTURE_DATE },
    ]),
    update: jest.fn(),
    set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(updateResult) }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  };
  tx.select.mockReturnValue(tx);
  tx.from.mockReturnValue(tx);
  tx.where.mockReturnValue(tx);
  tx.for.mockReturnValue(tx);
  tx.update.mockReturnValue(tx);
  return tx;
}

function buildMockDb() {
  const query = buildQuery();
  const universalTx = buildUniversalTx(query);
  const selectChain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  return {
    universalTx,
    query,
    select: jest.fn().mockReturnValue(selectChain),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof universalTx) => Promise<unknown>) => fn(universalTx),
    ),
  };
}

describe("InvitationLifecycleService.resend — seat admission for time-expired invitations", () => {
  let svc: InvitationLifecycleService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };
  let mockSeatLedger: { recordSeatEvent: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    mockSeatLedger = { recordSeatEvent: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        InvitationLifecycleService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EmailService,
          useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: SeatLedgerService, useValue: mockSeatLedger },
        {
          provide: AccessService,
          useValue: {
            canManageOrganizationMembership: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    svc = module.get(InvitationLifecycleService);
  });

  it("does not acquire the quota lock or check the plan limit when the invitation is still live", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: FUTURE_DATE },
    ]);

    await svc.resend(ORG_ID, INVITATION_ID, ACTOR);

    expect(mockPlanLimits.assertWithinLimit).not.toHaveBeenCalled();
    expect(mockSeatLedger.recordSeatEvent).not.toHaveBeenCalled();
  });

  it("acquires the quota lock before calling assertWithinLimit for a time-expired invitation", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);

    await svc.resend(ORG_ID, INVITATION_ID, ACTOR);

    const lockOrder = mockDb.universalTx.execute.mock.invocationCallOrder[0] ?? 0;
    const limitOrder = mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0;
    expect(lockOrder).toBeGreaterThan(0);
    expect(limitOrder).toBeGreaterThan(0);
    expect(lockOrder).toBeLessThan(limitOrder);
  });

  it("calls assertWithinLimit with increment=1 and the transaction when invitation is time-expired", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);

    await svc.resend(ORG_ID, INVITATION_ID, ACTOR);

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(
      ORG_ID,
      "members",
      1,
      mockDb.universalTx,
    );
  });

  it("throws ForbiddenException when the org is at capacity and the invitation is time-expired", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members."),
    );

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockSeatLedger.recordSeatEvent).not.toHaveBeenCalled();
  });

  it("records INVITE_SENT seat event when a time-expired invitation is successfully resent", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);

    await svc.resend(ORG_ID, INVITATION_ID, ACTOR);

    expect(mockSeatLedger.recordSeatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        eventType: "INVITE_SENT",
        subjectId: INVITATION_ID,
      }),
      mockDb.universalTx,
    );
  });

  it("does not record a seat event when resending a still-live invitation", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: FUTURE_DATE },
    ]);

    await svc.resend(ORG_ID, INVITATION_ID, ACTOR);

    expect(mockSeatLedger.recordSeatEvent).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the in-transaction row-lock finds no matching invitation", async () => {
    mockDb.universalTx.limit.mockResolvedValue([]);

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPlanLimits.assertWithinLimit).not.toHaveBeenCalled();
  });

  it("returns NotFoundException from pre-transaction lookup when the invitation does not exist", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(null);

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("(i) re-acquires the advisory lock AND asserts the seat limit in the same transaction for an expired invitation", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);

    await svc.resend(ORG_ID, INVITATION_ID, ACTOR);

    const lockCalled = mockDb.universalTx.execute.mock.calls.length > 0;
    const limitCalled = mockPlanLimits.assertWithinLimit.mock.calls.length > 0;
    expect(lockCalled).toBe(true);
    expect(limitCalled).toBe(true);

    const lockOrder = mockDb.universalTx.execute.mock.invocationCallOrder[0] ?? 0;
    const limitOrder = mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0;
    expect(lockOrder).toBeLessThan(limitOrder);
  });

  it("(ii) fails closed when the seat limit is exhausted between original invite and resend", async () => {
    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Seat limit reached"),
    );

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockSeatLedger.recordSeatEvent).not.toHaveBeenCalled();
  });

  it("(iii) second concurrent resend fails when the invitation expiresAt has already changed (prevents double-resend)", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue({
      ...BASE_INVITATION,
      expiresAt: PAST_DATE,
    });

    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: PAST_DATE },
    ]);

    mockDb.universalTx.set.mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    });

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("(iii) the concurrent resend guard uses the pre-transaction expiresAt, not the in-transaction value", async () => {
    const PRE_TX_EXPIRY = PAST_DATE;
    const POST_TX_EXPIRY = new Date(Date.now() + 7 * 86_400_000);

    mockDb.query.invitations.findFirst.mockResolvedValue({
      ...BASE_INVITATION,
      expiresAt: PRE_TX_EXPIRY,
    });

    mockDb.universalTx.limit.mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt: POST_TX_EXPIRY },
    ]);

    const capturedWhere: unknown[] = [];
    const updateResultZeroRows = {
      returning: jest.fn().mockResolvedValue([]),
    };
    const whereStub = jest.fn().mockImplementation((...args: unknown[]) => {
      capturedWhere.push(args);
      return updateResultZeroRows;
    });
    mockDb.universalTx.set.mockReturnValue({ where: whereStub });

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(whereStub).toHaveBeenCalled();
  });
});
