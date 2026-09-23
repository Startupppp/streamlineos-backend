import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONTROLLER = readFileSync(
  resolve(process.cwd(), "src/modules/users/users.controller.ts"),
  "utf8",
);
const LIFECYCLE = readFileSync(
  resolve(
    process.cwd(),
    "src/modules/organization/core/invitation-lifecycle.service.ts",
  ),
  "utf8",
);

describe("an admin can copy a working join link without a mailbox, and the raw token still never rests anywhere", () => {
  it("reissues rather than reading a stored token, because only the hash is persisted", () => {
    expect(LIFECYCLE).toContain("tokenHash: hashToken(rawToken)");
    expect(LIFECYCLE).not.toMatch(/\.set\(\{[^}]*\brawToken\b\s*[,:]/);
  });

  it("returns the token from exactly one route, and that route is a POST", () => {
    const joinLinkRoute = CONTROLLER.slice(
      CONTROLLER.indexOf('@Post("invitations/:invitationId/join-link")'),
    );
    expect(joinLinkRoute).toContain("reissued.rawToken");
    expect(
      CONTROLLER.match(/reissued\.rawToken|\.rawToken/g)?.length ?? 0,
    ).toBe(1);
  });

  it("keeps the token out of the resend response, whose replay is stored by @Idempotent", () => {
    const resend = CONTROLLER.slice(
      CONTROLLER.indexOf('@Post("invitations/:invitationId/resend")'),
      CONTROLLER.indexOf('@Post("invitations/:invitationId/join-link")'),
    );
    expect(resend).toContain("@Idempotent");
    expect(resend).not.toContain("rawToken");
    expect(resend).toContain("return { success: true as const };");
  });

  it("does not mark the join-link route idempotent, which would store the token it returns", () => {
    const joinLinkRoute = CONTROLLER.slice(
      CONTROLLER.indexOf('@Post("invitations/:invitationId/join-link")'),
      CONTROLLER.indexOf("reissueInvitationJoinLink"),
    );
    expect(joinLinkRoute).not.toContain("@Idempotent");
  });

  it("gates the route on membership management and rate-limits it", () => {
    const declaration = CONTROLLER.slice(
      CONTROLLER.lastIndexOf(
        '@RequirePermission("settings:organization:manage")',
        CONTROLLER.indexOf('@Post("invitations/:invitationId/join-link")'),
      ),
      CONTROLLER.indexOf("reissueInvitationJoinLink"),
    );
    expect(declaration).toContain(
      '@RequirePermission("settings:organization:manage")',
    );
    expect(declaration).toContain('@UseRateLimit("invite:reissue-link")');
  });

  it("still refuses an invitation that is not PENDING and unaccepted", () => {
    expect(LIFECYCLE).toContain('eq(invitations.status, "PENDING")');
    expect(LIFECYCLE).toContain("isNull(invitations.acceptedAt)");
    expect(LIFECYCLE).toContain("assertMayManageOrganizationMembership");
  });

  it("records the reissue separately from a resend so the audit trail distinguishes them", () => {
    expect(LIFECYCLE).toContain('"user.invitation.link-reissued"');
  });
});
