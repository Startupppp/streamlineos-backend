import { ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../common/auth/principal";
import { UserOpsService } from "./user-ops.service";

const ORG_ID = "org-rank-test";
const TARGET_USER_ID = "user-target-1";

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: ACCOUNT_ONLY_PRINCIPAL,
    ...overrides,
  };
}

function buildService(targetMember: { userStatus: string; isOwner: boolean }) {
  const svc = Object.create(UserOpsService.prototype) as UserOpsService;
  Object.assign(svc, {
    db: {
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({ email: "target@example.com" }),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      }),
    },
    usersSvc: {
      getUser: jest.fn().mockResolvedValue(targetMember),
    },
    email: { sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined) },
    audit: { log: jest.fn() },
  });
  return svc;
}

describe("UserOpsService.sendSigninLink actor-rank guard", () => {
  it("refuses a non-owner actor minting a redeemable credential for the organization owner", async () => {
    const svc = buildService({ userStatus: "active", isOwner: true });
    await expect(
      svc.sendSigninLink(ORG_ID, TARGET_USER_ID, actor({ isOrgOwner: false })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("names the org owner in the refusal so the caller is not left guessing at a generic denial", async () => {
    const svc = buildService({ userStatus: "active", isOwner: true });
    await expect(
      svc.sendSigninLink(ORG_ID, TARGET_USER_ID, actor({ isOrgOwner: false })),
    ).rejects.toThrow(/organization owner/i);
  });

  it("allows the organization owner to mint a sign-in link for themselves", async () => {
    const svc = buildService({ userStatus: "active", isOwner: true });
    await expect(
      svc.sendSigninLink(ORG_ID, TARGET_USER_ID, actor({ isOrgOwner: true })),
    ).resolves.toMatchObject({ success: true });
  });

  it("allows a non-owner actor to mint a sign-in link for a non-owner subject", async () => {
    const svc = buildService({ userStatus: "active", isOwner: false });
    await expect(
      svc.sendSigninLink(ORG_ID, TARGET_USER_ID, actor({ isOrgOwner: false })),
    ).resolves.toMatchObject({ success: true });
  });
});
