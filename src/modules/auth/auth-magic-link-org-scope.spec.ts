import { UnauthorizedException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { AuthMagicLinkService } from "./auth-magic-link.service";

type TokenRow = { id: string; userId: string; orgId: string | null; usedAt: Date | null };

function makeService(token: TokenRow, memberships: readonly string[], preferredOrgId: string | null) {
  const resolveActiveMembership = jest.fn(async (_userId: string, preferred: string | null) => {
    const match = preferred !== null && memberships.includes(preferred) ? preferred : memberships[0];
    return match === undefined
      ? null
      : {
          orgId: match,
          isOwner: false,
          role: "MEMBER",
          maxConcurrentSessions: null,
          orgOnboardingCompletedAt: null,
          memberOnboardingCompletedAt: null,
        };
  });

  const db = {
    query: {
      magicLinkTokens: { findFirst: jest.fn().mockResolvedValue(token) },
      users: { findFirst: jest.fn().mockResolvedValue({ isActive: true, deletedAt: null }) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => {
          const result = Promise.resolve([{ id: token.id }]);
          return Object.assign(result, { returning: () => Promise.resolve([{ id: token.id }]) });
        }),
      }),
    }),
  } as unknown as Db;

  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) } as never;
  const email = {} as never;
  const membershipResolver = {
    resolvePreferredOrgId: jest.fn().mockResolvedValue(preferredOrgId),
    resolveActiveMembership,
    createLoginSession: jest.fn().mockResolvedValue("session-1"),
  } as never;
  const logLoginEvent = jest.fn().mockResolvedValue(undefined);
  const analytics = { logLoginEvent } as never;

  return {
    svc: new AuthMagicLinkService(db, cache, email, membershipResolver, analytics),
    logLoginEvent,
  };
}

const context = { userAgent: "jest", ipAddress: "127.0.0.1" };

describe("a magic link minted on behalf of an organization redeems into that organization", () => {
  it("lands the session in the minting org even though the user prefers a different one", async () => {
    const { svc } = makeService(
      { id: "tok-1", userId: "user-1", orgId: "org-inviting", usedAt: null },
      ["org-preferred", "org-inviting"],
      "org-preferred",
    );

    await expect(svc.verifyMagicLink("raw-token", context)).resolves.toMatchObject({
      orgId: "org-inviting",
    });
  });

  it("refuses the link rather than falling back when the user is no longer a member of the minting org", async () => {
    const { svc } = makeService(
      { id: "tok-2", userId: "user-1", orgId: "org-inviting", usedAt: null },
      ["org-somewhere-else"],
      "org-somewhere-else",
    );

    await expect(svc.verifyMagicLink("raw-token", context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("records the refusal against the org that minted the link, so the audit trail names the right tenant", async () => {
    const { svc, logLoginEvent } = makeService(
      { id: "tok-3", userId: "user-1", orgId: "org-inviting", usedAt: null },
      ["org-somewhere-else"],
      "org-somewhere-else",
    );

    await expect(svc.verifyMagicLink("raw-token", context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(logLoginEvent).toHaveBeenCalledWith(
      "user-1",
      "org-inviting",
      "magic_link.verify",
      false,
      "membership_not_in_minting_org",
      context,
    );
  });
});

describe("an org-neutral link keeps resolving through the user's preferred org", () => {
  it("uses the preferred org when the token names none, so self-service sign-in is unchanged", async () => {
    const { svc } = makeService(
      { id: "tok-4", userId: "user-1", orgId: null, usedAt: null },
      ["org-preferred", "org-other"],
      "org-preferred",
    );

    await expect(svc.verifyMagicLink("raw-token", context)).resolves.toMatchObject({
      orgId: "org-preferred",
    });
  });

  it("still falls back to any active membership when the token names none and there is no preference", async () => {
    const { svc } = makeService(
      { id: "tok-5", userId: "user-1", orgId: null, usedAt: null },
      ["org-only"],
      null,
    );

    await expect(svc.verifyMagicLink("raw-token", context)).resolves.toMatchObject({
      orgId: "org-only",
    });
  });
});

describe("minting org is an assertion not a preference — parameterized to prevent tautology", () => {
  it.each([
    { mintingOrg: "org-alpha", otherOrg: "org-beta" },
    { mintingOrg: "org-beta", otherOrg: "org-alpha" },
  ])(
    "token minted for $mintingOrg redeems into $mintingOrg even when the user prefers $otherOrg",
    async ({ mintingOrg, otherOrg }) => {
      const { svc } = makeService(
        { id: "tok-param", userId: "user-1", orgId: mintingOrg, usedAt: null },
        [otherOrg, mintingOrg],
        otherOrg,
      );

      await expect(svc.verifyMagicLink("raw-token", context)).resolves.toMatchObject({
        orgId: mintingOrg,
      });
    },
  );

  it.each([
    { mintingOrg: "org-alpha", otherOrg: "org-beta" },
    { mintingOrg: "org-beta", otherOrg: "org-alpha" },
  ])(
    "refuses the link rather than landing in $otherOrg when the user is no longer a member of $mintingOrg",
    async ({ mintingOrg, otherOrg }) => {
      const { svc } = makeService(
        { id: "tok-param-refuse", userId: "user-1", orgId: mintingOrg, usedAt: null },
        [otherOrg],
        otherOrg,
      );

      await expect(svc.verifyMagicLink("raw-token", context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );
});
