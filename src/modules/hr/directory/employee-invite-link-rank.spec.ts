import { ForbiddenException } from "@nestjs/common";
import { EmployeeOnboardingService } from "./employee-onboarding.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

type TargetRow = {
  email: string;
  isActive: boolean;
  membershipStatus: string;
  isOwner: boolean;
};

function makeDb(target: TargetRow | undefined) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(target ? [target] : []),
          }),
        }),
      }),
    }),
  } as never;
}

function makeService(target: TargetRow | undefined): EmployeeOnboardingService {
  const svc = Object.create(
    EmployeeOnboardingService.prototype,
  ) as EmployeeOnboardingService;
  Object.assign(svc, {
    db: makeDb(target),
    audit: { logCritical: jest.fn() },
    cache: { invalidate: jest.fn() },
  });
  return svc;
}

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "hr-manager",
    orgId: "org-1",
    isOrgOwner: false,
    ...overrides,
  } as CurrentUserContext;
}

const OWNER: TargetRow = {
  email: "owner@example.com",
  isActive: true,
  membershipStatus: "ACTIVE",
  isOwner: true,
};

describe("an invite link is a redeemable login credential, so minting one for the org owner is an escalation", () => {
  it("refuses a non-owner minting a link for the organization owner", async () => {
    await expect(
      makeService(OWNER).createInviteLink(actor(), "owner-user"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("names the rank in the refusal, so the caller is not left guessing at a generic denial", async () => {
    await expect(
      makeService(OWNER).createInviteLink(actor(), "owner-user"),
    ).rejects.toThrow(/organization owner/i);
  });

  it("lets the organization owner mint one for themselves, so the control is a rank check and not a ban", async () => {
    await expect(
      makeService(OWNER).createInviteLink(
        actor({ isOrgOwner: true }),
        "owner-user",
      ),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });
});
