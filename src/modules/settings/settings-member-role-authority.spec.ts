import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { SettingsService } from "./settings.service";

/**
 * `POST /settings/users/:userId/role` and `PATCH /organization/members/:memberId`
 * were two implementations of one write, reached through two different
 * permission keys — and the settings one was the weaker: it took no row lock,
 * ran no last-structural-admin check, no module-ownership check, wrote no audit
 * entry and sent no role-changed notification. Holding `settings:rbac:manage`
 * was therefore enough to demote the last org admin through a route the
 * organization module refuses.
 *
 * The rewrite absorbs the settings path rather than standing beside it: the
 * handler stays (a shipped client calls it) and delegates. These tests are the
 * convergence proof — reinstate the local transaction and the second and third
 * cases fail.
 */

const actor: CurrentUserContext = {
  userId: "org-admin",
  orgId: "org-1",
  role: "ORG_ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

async function buildService(
  updateMemberRole: jest.Mock,
): Promise<{
  service: SettingsService;
  transaction: jest.Mock;
  update: jest.Mock;
  invalidate: jest.Mock;
}> {
  const transaction = jest.fn();
  const update = jest.fn();
  const db = {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction,
    update,
  };
  const invalidate = jest.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OrgMembershipService, useValue: { updateMemberRole } },
      { provide: CacheService, useValue: { invalidate } },
    ],
  }).compile();

  return { service: moduleRef.get(SettingsService), transaction, update, invalidate };
}

describe("SettingsService.updateUserRole converges on the organization membership service", () => {
  it("delegates the role change, passing the caller's own identity and ownership standing", async () => {
    const updateMemberRole = jest.fn().mockResolvedValue({ success: true });
    const { service } = await buildService(updateMemberRole);

    await service.updateUserRole(actor, "member-1", "MEMBER");

    expect(updateMemberRole).toHaveBeenCalledTimes(1);
    expect(updateMemberRole).toHaveBeenCalledWith(
      "org-1",
      { userId: "org-admin", isOrgOwner: false },
      "member-1",
      "MEMBER",
    );
  });

  it("keeps no second write path of its own — no transaction, no update, no cache bust", async () => {
    const updateMemberRole = jest.fn().mockResolvedValue({ success: true });
    const { service, transaction, update, invalidate } =
      await buildService(updateMemberRole);

    await service.updateUserRole(actor, "member-1", "MEMBER");

    expect(transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("preserves the published response shape the settings path has always returned", async () => {
    const updateMemberRole = jest.fn().mockResolvedValue({ success: true });
    const { service } = await buildService(updateMemberRole);

    await expect(
      service.updateUserRole(actor, "member-1", "MEMBER"),
    ).resolves.toEqual({ success: true, userId: "member-1", role: "MEMBER" });
  });

  it("propagates a refusal from the surviving path instead of writing anyway", async () => {
    const updateMemberRole = jest
      .fn()
      .mockRejectedValue(new ForbiddenException("Permission denied"));
    const { service, transaction, update } = await buildService(updateMemberRole);

    await expect(
      service.updateUserRole(actor, "member-1", "MEMBER"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
