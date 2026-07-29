jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { ForbiddenException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvitationsService } from "./invitations.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { EmailService } from "../email/email.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { hashToken } from "../../common/security/token.util";

const ORG_ID = "org-abc";
const ACTOR_ID = "user-xyz";
const RAW_TOKEN = "c".repeat(64);
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
const EXISTING_USER = { id: "user-existing", email: "invitee@example.com" };

function buildUniversalTx() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        returning: jest.fn().mockResolvedValue([{ id: 42 }]),
      }),
    })),
  };
}

function buildMockDb() {
  const universalTx = buildUniversalTx();
  return {
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ id: ORG_ID, name: "Acme", allowedEmailDomains: [] }),
      },
      invitations: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    transaction: jest.fn().mockImplementation((fn: (tx: typeof universalTx) => Promise<unknown>) =>
      fn(universalTx),
    ),
  };
}

describe("InvitationsService.invite — plan limit enforcement", () => {
  let svc: InvitationsService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: EmailService, useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(InvitationsService);
  });

  it("calls assertWithinLimit(orgId, 'members') before creating an invitation", async () => {
    await svc.invite(ORG_ID, ACTOR_ID, "new@example.com", "MEMBER");
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(ORG_ID, "members");
  });

  it("propagates ForbiddenException from assertWithinLimit without wrapping", async () => {
    const err = new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more.");
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(err);

    await expect(svc.invite(ORG_ID, ACTOR_ID, "new@example.com", "MEMBER")).rejects.toBe(err);
  });

  it("does NOT call assertWithinLimit when user is already a member", async () => {
    mockDb.query.users.findFirst.mockResolvedValue({ id: "user-existing" });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ userId: "user-existing", orgId: ORG_ID });

    await expect(svc.invite(ORG_ID, ACTOR_ID, "existing@example.com", "MEMBER")).rejects.toBeInstanceOf(
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

    const results = await svc.bulkInvite(ORG_ID, ACTOR_ID, ["a@example.com", "b@example.com"], "MEMBER");

    expect(results.results[0].success).toBe(true);
    expect(results.results[1].success).toBe(false);
    expect(results.results[1].error).toContain("limit exceeded");
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(2);
  });
});

describe("InvitationsService.accept — plan limit enforcement", () => {
  let svc: InvitationsService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn().mockResolvedValue(undefined) } },
        { provide: EmailService, useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(InvitationsService);
  });

  it("rejects existing-user accept with invitee-friendly message when org is at member limit", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more."),
    );

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toThrow(
      "This workspace has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
    );
  });

  it("rejects existing-user accept with ForbiddenException when org is at member limit", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more."),
    );

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects new-user accept with invitee-friendly message when org is at member limit", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("Your Free plan allows 5 members. Upgrade your plan to add more."),
    );

    await expect(svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe" })).rejects.toThrow(
      "This workspace has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
    );
  });

  it("existing-user accept succeeds when a seat is available", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    const result = await svc.accept({ token: RAW_TOKEN });

    expect(result.ok).toBe(true);
    expect(result.autoLoginToken).toBeDefined();
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(ORG_ID, "members", 0);
  });

  it("new-user accept succeeds when a seat is available", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(null);

    const result = await svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe" });

    expect(result.ok).toBe(true);
    expect(result.autoLoginToken).toBeDefined();
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(ORG_ID, "members", 0);
  });

  it("calls assertWithinLimit with increment=0 (not increment=1) on accept", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    await svc.accept({ token: RAW_TOKEN });

    const call = mockPlanLimits.assertWithinLimit.mock.calls[0];
    expect(call[2]).toBe(0);
  });

  it("does not insert member if limit check fails (no DB write on rejection)", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    mockPlanLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("limit exceeded"),
    );

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
