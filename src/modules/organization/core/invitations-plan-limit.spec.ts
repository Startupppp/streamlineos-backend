jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { AccessService } from "../../access/access.service";
import { ForbiddenException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvitationCreateService } from "./invitation-create.service";
import { MembershipAdmissionService } from "./membership-admission.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { hashToken } from "../../../common/security/token.util";
import { invitations as invitationsTable } from "../../../db/schema";

const ORG_ID = "org-abc";
const ACTOR_ID = "user-xyz";
const RAW_TOKEN = "c".repeat(64);
/**
 * Accept has required an email verification code since the invitation link
 * stopped being accepted as proof of who holds it. Every accept in this file
 * carries one, because a call without it is refused before it reaches the plan
 * limit these tests are about — which is why they all errored silently once the
 * requirement landed.
 */
const OTP_CODE = "123456";
const BASE_INVITATION = {
  id: "inv-limit-1",
  email: "invitee@example.com",
  orgId: ORG_ID,
  role: "MEMBER",
  tokenHash: hashToken(RAW_TOKEN),
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  status: "PENDING",
};
const EXISTING_USER = {
  id: "user-existing",
  email: "invitee@example.com",
  isActive: true,
  deletedAt: null,
};

type MockQuery = {
  users: { findFirst: jest.Mock };
  organizationMembers: { findFirst: jest.Mock };
  organizations: { findFirst: jest.Mock };
  invitations: { findFirst: jest.Mock };
};

/** `db` and the transaction handle must share one query object: the service reads
 *  through `tx.query.*` inside the tenant transaction, while tests stub `db.query.*`. */
function buildQuery(): MockQuery {
  return {
    users: { findFirst: jest.fn().mockResolvedValue(null) },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    organizations: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORG_ID,
        name: "Acme",
        status: "ACTIVE",
        deletedAt: null,
        allowedEmailDomains: [],
      }),
    },
    invitations: { findFirst: jest.fn().mockResolvedValue(BASE_INVITATION) },
    invitationEmailOtps: {
      findFirst: jest.fn().mockResolvedValue({
        id: 1,
        invitationId: BASE_INVITATION.id,
        codeHash: hashToken(OTP_CODE),
        attempts: 0,
      }),
    },
  };
}

function buildUniversalTx(query: MockQuery) {
  const updateResult = {
    returning: jest.fn().mockResolvedValue([{ id: BASE_INVITATION.id }]),
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  };
  return {
    execute: jest.fn().mockResolvedValue([]),
    query,
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(updateResult),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        returning: jest.fn().mockResolvedValue([{ id: 42 }]),
      }),
    })),
  };
}

function buildMockDb() {
  const query = buildQuery();
  const universalTx = buildUniversalTx(query);
  return {
    universalTx,
    query,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    // `verifyAndConsumeInvitationOtp` runs on the db handle, not the tenant tx:
    // it bumps the attempt counter, then marks the code used.
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ attempts: 1 }]),
          then: (resolve: (value: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation((fn: (tx: typeof universalTx) => Promise<unknown>) =>
      fn(universalTx),
    ),
  };
}

describe("InvitationCreateService.invite — plan limit enforcement", () => {
  let svc: InvitationCreateService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        InvitationCreateService,
        MembershipAdmissionService,
        InvitationLifecycleService,
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },

        { provide: SeatLedgerService, useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateNamespace: jest.fn().mockResolvedValue(undefined), invalidateForOrg: jest.fn().mockResolvedValue(undefined), invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined) } },
        { provide: EmailService, useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) },
        },
      ],
    }).compile();

    svc = module.get(InvitationCreateService);
  });

  it("checks the member limit inside the serialized tenant transaction", async () => {
    await svc.invite(ORG_ID, { userId: ACTOR_ID, isOrgOwner: true }, "new@example.com", "MEMBER");
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(
      ORG_ID,
      "members",
      1,
      mockDb.universalTx,
    );
    expect(mockDb.universalTx.execute).toHaveBeenCalled();
    expect(mockDb.universalTx.execute.mock.invocationCallOrder[1]).toBeLessThan(
      mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("propagates ForbiddenException from assertWithinLimit without wrapping", async () => {
    const err = new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more.");
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(err);

    await expect(svc.invite(ORG_ID, { userId: ACTOR_ID, isOrgOwner: true }, "new@example.com", "MEMBER")).rejects.toBe(err);
  });

  it("does NOT call assertWithinLimit when user is already a member", async () => {
    mockDb.query.users.findFirst.mockResolvedValue({ id: "user-existing" });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ userId: "user-existing", orgId: ORG_ID });

    await expect(svc.invite(ORG_ID, { userId: ACTOR_ID, isOrgOwner: true }, "existing@example.com", "MEMBER")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mockPlanLimits.assertWithinLimit).not.toHaveBeenCalled();
  });

  it("pending invitations from a bulkInvite are counted on each subsequent invite call", async () => {
    let callCount = 0;
    mockPlanLimits.assertWithinLimit.mockImplementation(() => {
      callCount++;
      if (callCount > 1) {
        return Promise.reject(new ForbiddenException("limit exceeded"));
      }
      return Promise.resolve();
    });

    const results = await svc.bulkInvite(ORG_ID, { userId: ACTOR_ID, isOrgOwner: true }, ["a@example.com", "b@example.com"], "MEMBER");

    expect(results.results[0].success).toBe(true);
    expect(results.results[1].success).toBe(false);
    expect(results.results[1].error).toContain("limit exceeded");
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(2);
  });
});

describe("InvitationAcceptanceService.accept — plan limit enforcement", () => {
  let svc: InvitationAcceptanceService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    // Acceptance runs two `select`s in its transaction: the invitation row lock
    // and the allowed-domain read. Answering both with an invitation row hands
    // the domain screen a row with no `domain` column.
    mockDb.universalTx.limit.mockImplementation(() => {
      const fromCalls: unknown[][] = mockDb.universalTx.from.mock.calls;
      const lastTable = fromCalls.at(-1)?.[0];
      return Promise.resolve(lastTable === invitationsTable ? [BASE_INVITATION] : []);
    });
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },

        { provide: SeatLedgerService, useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: CacheService, useValue: { invalidate: jest.fn().mockResolvedValue(undefined), invalidateNamespace: jest.fn().mockResolvedValue(undefined), invalidateForOrg: jest.fn().mockResolvedValue(undefined), invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        // Added when the invitation OTP landed. Without it Nest cannot construct
        // the service, and every accept test in this file errored before it ran
        // an assertion — which is how the whole accept surface went untested
        // through the release that broke it.
        { provide: EmailService, useValue: { sendEmailOtpEmail: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(InvitationAcceptanceService);
  });

  /**
   * BUG-HRMS-010. The requirement applies to EVERY accept, including an invitee
   * who already holds a StreamlineOS account: `accept` is a public route with no
   * session, so a signed-in caller is indistinguishable from anyone else holding
   * the link, and the code is the only proof of the mailbox. A client that offers
   * an existing-account invitee a one-click "Accept & join" without first
   * requesting a code cannot succeed — which is what the frontend was doing.
   */
  it("refuses an accept that carries no verification code, existing account included", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
      "An email verification code is required to accept this invitation",
    );
    expect(mockPlanLimits.assertWithinLimit).not.toHaveBeenCalled();
  });

  it("rejects existing-user accept with invitee-friendly message when org is at member limit", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more."),
    );

    await expect(svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE })).rejects.toThrow(
      "This organization has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
    );
  });

  it("rejects existing-user accept with ForbiddenException when org is at member limit", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more."),
    );

    await expect(svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects new-user accept with invitee-friendly message when org is at member limit", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more."),
    );

    await expect(svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe", emailOtp: OTP_CODE })).rejects.toThrow(
      "This organization has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
    );
  });

  it("existing-user accept succeeds when a seat is available", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    const result = await svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE });

    expect(result.ok).toBe(true);
    expect(result.autoLoginToken).toBeDefined();
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(
      ORG_ID,
      "members",
      0,
      mockDb.universalTx,
    );
  });

  it("new-user accept succeeds when a seat is available", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(null);

    const result = await svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe", emailOtp: OTP_CODE });

    expect(result.ok).toBe(true);
    expect(result.autoLoginToken).toBeDefined();
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(
      ORG_ID,
      "members",
      0,
      mockDb.universalTx,
    );
  });

  it("calls assertWithinLimit with increment=0 (not increment=1) on accept", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    await svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE });

    const call = mockPlanLimits.assertWithinLimit.mock.calls[0];
    expect(call[2]).toBe(0);
    expect(call[3]).toBe(mockDb.universalTx);
    expect(mockDb.universalTx.execute).toHaveBeenCalled();
    expect(mockDb.universalTx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not insert member if limit check fails (no DB write on rejection)", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("limit exceeded"),
    );

    await expect(svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never accepts an invitation without an accepted membership id", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockDb.universalTx.insert.mockImplementation(() => ({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
        returning: jest.fn().mockResolvedValue([]),
      }),
    }));

    await expect(svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects a concurrent loser before creating a membership", async () => {
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockDb.universalTx.limit.mockResolvedValue([]);

    await expect(svc.accept({ token: RAW_TOKEN, emailOtp: OTP_CODE })).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(mockDb.universalTx.insert).not.toHaveBeenCalled();
  });
});
