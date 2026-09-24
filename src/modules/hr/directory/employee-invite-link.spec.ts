import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  EMPLOYEE_NOT_FOUND_MESSAGE,
  SUSPENDED_ACCOUNT_MESSAGE,
} from "./employee-onboarding.service";
import { buildService, makeHarness, type Harness } from "./employee-onboarding.spec-fixtures";

/**
 * HRMS-E2E-001b. The invite had exactly one delivery route: an email. In the
 * environment QA tested, nothing arrived at two separate inboxes over three
 * minutes, and there was no second way in — onboarding stopped for the whole
 * organisation with the UI still reporting "Invitation sent".
 *
 * A copy-link path is what makes that survivable, but only if the link it hands
 * out is the same kind of credential the email carries. These assertions pin
 * that: same tenant scoping as every other employee read, same retirement of
 * earlier links, the token in the response and nowhere else, and an audit row
 * naming the actor.
 */
const ORG_ID = "org-invite-link";
const ACTOR = { orgId: ORG_ID, userId: "actor-1", isOrgOwner: true };
const TARGET = "user-target-1";

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    email: "target@example.com",
    isActive: true,
    membershipStatus: "ACTIVE",
    ...overrides,
  };
}

function harnessWith(rows: unknown[]): Harness {
  return makeHarness({ selects: { organization_members: [rows] } });
}

describe("EmployeeOnboardingService.createInviteLink", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("answers 404, never 403, for someone who is not a member of the actor's organization", async () => {
    const harness = harnessWith([]);
    const { service } = buildService(harness.db);

    await expect(service.createInviteLink(ACTOR as never, TARGET)).rejects.toThrow(
      new NotFoundException(EMPLOYEE_NOT_FOUND_MESSAGE),
    );
    // Nothing is minted for a person the caller cannot see.
    expect(harness.inserted).toEqual([]);
  });

  it("treats a departed membership as not found", async () => {
    const harness = harnessWith([memberRow({ membershipStatus: "LEFT" })]);
    const { service } = buildService(harness.db);

    await expect(service.createInviteLink(ACTOR as never, TARGET)).rejects.toThrow(NotFoundException);
    expect(harness.inserted).toEqual([]);
  });

  it("refuses a globally suspended account rather than minting a link into it", async () => {
    const harness = harnessWith([memberRow({ isActive: false })]);
    const { service } = buildService(harness.db);

    await expect(service.createInviteLink(ACTOR as never, TARGET)).rejects.toThrow(
      new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE),
    );
    expect(harness.inserted).toEqual([]);
  });

  it("returns a usable join link and the address it belongs to", async () => {
    const harness = harnessWith([memberRow()]);
    const { service } = buildService(harness.db);

    const result = await service.createInviteLink(ACTOR as never, TARGET);

    expect(result.inviteUrl).toContain("/magic-link?token=");
    expect(result.email).toBe("target@example.com");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("stores only a hash, never the token itself", async () => {
    const harness = harnessWith([memberRow()]);
    const { service } = buildService(harness.db);

    const result = await service.createInviteLink(ACTOR as never, TARGET);
    const rawToken = new URL(result.inviteUrl).searchParams.get("token") ?? "";

    expect(rawToken).toHaveLength(64);
    const written = JSON.stringify(harness.inserted);
    expect(written).toContain("magic_link_tokens");
    expect(written).not.toContain(rawToken);
  });

  it("retires every earlier link, so the one just handed out is the only one that works", async () => {
    const harness = harnessWith([memberRow()]);
    const { service } = buildService(harness.db);

    await service.createInviteLink(ACTOR as never, TARGET);

    expect(harness.updated).toEqual([
      { table: "magic_link_tokens", set: expect.objectContaining({ usedAt: expect.any(Date) }) },
    ]);
  });

  it("records who took a link for whom, without putting the token in the audit row", async () => {
    const harness = harnessWith([memberRow()]);
    const { service, logCritical } = buildService(harness.db);

    const result = await service.createInviteLink(ACTOR as never, TARGET);
    const rawToken = new URL(result.inviteUrl).searchParams.get("token") ?? "";

    expect(logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employee_invite_link_taken",
        orgId: ORG_ID,
        userId: ACTOR.userId,
        targetId: TARGET,
      }),
    );
    expect(JSON.stringify(logCritical.mock.calls)).not.toContain(rawToken);
  });
});
