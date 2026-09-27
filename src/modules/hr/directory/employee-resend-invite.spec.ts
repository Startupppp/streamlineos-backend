import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  EMPLOYEE_NOT_FOUND_MESSAGE,
  SUSPENDED_ACCOUNT_MESSAGE,
} from "./employee-onboarding.service";
import {
  HARNESS_ORGANIZATION_NAME,
  buildService,
  makeHarness,
  type Harness,
} from "./employee-onboarding.spec-fixtures";

const ORG_ID = "org-resend";
const ACTOR = { orgId: ORG_ID, userId: "actor-1", isOrgOwner: true };
const NON_OWNER_ACTOR = { orgId: ORG_ID, userId: "actor-2", isOrgOwner: false };
const TARGET = "user-target-1";

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    email: "target@example.com",
    name: "Target Person",
    firstName: "Target",
    lastName: "Person",
    isActive: true,
    emailVerified: null,
    membershipStatus: "ACTIVE",
    ...overrides,
  };
}

function harnessWith(rows: unknown[]): Harness {
  return makeHarness({ selects: { organization_members: [rows] } });
}

describe("EmployeeOnboardingService.resendInvite", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("answers 404, never 403, when the id is not a member of the actor's organization", async () => {
    const harness = harnessWith([]);
    const { service, queueWelcomeEmail, queueMembershipAddedEmail } = buildService(harness.db);

    await expect(service.resendInvite(ACTOR as never, TARGET)).rejects.toThrow(
      new NotFoundException(EMPLOYEE_NOT_FOUND_MESSAGE),
    );

    expect(harness.inserted).toEqual([]);
    expect(queueWelcomeEmail).not.toHaveBeenCalled();
    expect(queueMembershipAddedEmail).not.toHaveBeenCalled();
  });

  it("treats a suspended or departed membership as not found", async () => {
    const harness = harnessWith([memberRow({ membershipStatus: "LEFT" })]);
    const { service } = buildService(harness.db);

    await expect(service.resendInvite(ACTOR as never, TARGET)).rejects.toThrow(NotFoundException);
    expect(harness.inserted).toEqual([]);
  });

  it("refuses a globally suspended account with 400 rather than mailing a dead login", async () => {
    const harness = harnessWith([memberRow({ isActive: false })]);
    const { service } = buildService(harness.db);

    await expect(service.resendInvite(ACTOR as never, TARGET)).rejects.toThrow(
      new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE),
    );
    expect(harness.inserted).toEqual([]);
  });

  it("re-sends the welcome mail with a fresh 7-day magic link to an account that has never verified, and audits it", async () => {
    const harness = harnessWith([memberRow()]);
    const { service, queueWelcomeEmail, queueMembershipAddedEmail, logCritical } = buildService(harness.db);

    await expect(service.resendInvite(ACTOR as never, TARGET)).resolves.toEqual({
      success: true,
      invite: { sent: true, reason: null },
    });

    const token = harness.inserted.find((row) => row.table === "magic_link_tokens");
    expect(token?.values).toEqual(
      expect.objectContaining({ userId: TARGET, tokenHash: expect.any(String), expiresAt: expect.any(Date) }),
    );
    expect(queueMembershipAddedEmail).not.toHaveBeenCalled();
    expect(queueWelcomeEmail).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      recipientUserId: TARGET,
      email: "target@example.com",
      name: "Target Person",
      setupUrl: expect.stringContaining("/magic-link?token="),
    });
    expect(logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employee_invite_resent",
        orgId: ORG_ID,
        userId: ACTOR.userId,
        targetId: TARGET,
        metadata: { email: "target@example.com", invite: { sent: true, reason: null } },
      }),
    );
  });

  it("tells a verified account it was added to the organization instead of welcoming it again", async () => {
    const harness = harnessWith([memberRow({ emailVerified: new Date("2026-01-01") })]);
    const { service, queueWelcomeEmail, queueMembershipAddedEmail } = buildService(harness.db);

    await service.resendInvite(ACTOR as never, TARGET);

    expect(queueWelcomeEmail).not.toHaveBeenCalled();
    expect(queueMembershipAddedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ organizationName: HARNESS_ORGANIZATION_NAME, recipientUserId: TARGET }),
    );
  });

  it("reports the outbox's reason and retires the token when the mail could not be queued", async () => {
    const harness = harnessWith([memberRow()]);
    const { service, queueWelcomeEmail } = buildService(harness.db);
    queueWelcomeEmail.mockResolvedValue({ queued: false, reason: "No email provider is configured." });

    await expect(service.resendInvite(ACTOR as never, TARGET)).resolves.toEqual({
      success: true,
      invite: { sent: false, reason: "No email provider is configured." },
    });

    // Two retirements, in this order and for different reasons. The first runs
    // before the new token is issued and retires every earlier invite, so a link
    // forwarded last week stops working the moment a fresh one is minted. The
    // second is the compensation: the mail could not be queued, so the token
    // just issued is retired too and nobody is left holding a link that was
    // never delivered.
    expect(harness.updated).toEqual([
      { table: "magic_link_tokens", set: expect.objectContaining({ usedAt: expect.any(Date) }) },
      { table: "magic_link_tokens", set: expect.objectContaining({ usedAt: expect.any(Date) }) },
    ]);
  });

  it("retires every earlier invite before issuing a new one", async () => {
    const harness = harnessWith([memberRow()]);
    const { service } = buildService(harness.db);

    await service.resendInvite(ACTOR as never, TARGET);

    // A resend used to mint another token and leave every earlier one live until
    // its seven-day expiry, so an invite resent to correct a mistake did not
    // recall the first link.
    expect(harness.updated).toEqual([
      { table: "magic_link_tokens", set: expect.objectContaining({ usedAt: expect.any(Date) }) },
    ]);
  });
});

describe("EmployeeOnboardingService.resendInvite — a resend link is a redeemable credential, so minting one for the owner is an escalation", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function ownerMemberRow() {
    return memberRow({ isOwner: true });
  }

  it("refuses a non-owner actor minting a resend credential for the organization owner", async () => {
    const harness = harnessWith([ownerMemberRow()]);
    const { service } = buildService(harness.db);

    await expect(
      service.resendInvite(NON_OWNER_ACTOR as never, TARGET),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(harness.inserted).toEqual([]);
  });

  it("names the org owner rank in the refusal", async () => {
    const harness = harnessWith([ownerMemberRow()]);
    const { service } = buildService(harness.db);

    await expect(
      service.resendInvite(NON_OWNER_ACTOR as never, TARGET),
    ).rejects.toThrow(/organization owner/i);
  });

  it("allows the organization owner to mint a resend link for themselves", async () => {
    const harness = harnessWith([ownerMemberRow()]);
    const { service } = buildService(harness.db);

    await expect(
      service.resendInvite(ACTOR as never, TARGET),
    ).resolves.toMatchObject({ success: true });
  });
});
