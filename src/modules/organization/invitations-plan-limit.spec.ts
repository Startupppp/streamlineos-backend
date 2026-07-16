jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { ForbiddenException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvitationsService } from "./invitations.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { EmailService } from "../email/email.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-abc";
const ACTOR_ID = "user-xyz";

function buildMockDb() {
  const universalTx = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
  };
  return {
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ id: ORG_ID, name: "Acme", allowedEmailDomains: [] }),
      },
      invitations: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
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
});
