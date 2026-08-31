jest.mock("../../common/rbac/sync-structural-role", () => ({
  syncStructuralRoleAssignment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
}));

import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AccessService } from "../access/access.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { SettingsService } from "./settings.service";

const actor: CurrentUserContext = {
  userId: "org-admin",
  orgId: "org-1",
  role: "ORG_ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

async function buildService(canManage: boolean): Promise<{
  service: SettingsService;
  transaction: jest.Mock;
  update: jest.Mock;
  canManageOrganizationMembership: jest.Mock;
}> {
  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  });
  const tx = { update };
  const transaction = jest
    .fn()
    .mockImplementation(async (work: (value: typeof tx) => Promise<void>) =>
      work(tx),
    );
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 7, isOwner: false }),
      },
    },
    transaction,
  };
  const canManageOrganizationMembership = jest
    .fn()
    .mockResolvedValue(canManage);
  const access = { canManageOrganizationMembership };
  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: DRIZZLE, useValue: db },
      { provide: PlanLimitsService, useValue: {} },
      { provide: AccessService, useValue: access },
      { provide: CacheService, useValue: {} },
    ],
  }).compile();

  return {
    service: moduleRef.get(SettingsService),
    transaction,
    update,
    canManageOrganizationMembership,
  };
}

describe("SettingsService.updateUserRole membership authority", () => {
  it("allows a structural organization administrator to change a member role", async () => {
    const {
      service,
      transaction,
      update,
      canManageOrganizationMembership,
    } = await buildService(true);

    await expect(
      service.updateUserRole(actor, "member-1", "MEMBER"),
    ).resolves.toEqual({
      success: true,
      userId: "member-1",
      role: "MEMBER",
    });
    expect(canManageOrganizationMembership).toHaveBeenCalledWith(
      "org-1",
      "org-admin",
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("rejects a custom settings grant before changing the role", async () => {
    const { service, transaction } = await buildService(false);
    const customManager: CurrentUserContext = { ...actor, role: "MEMBER" };

    await expect(
      service.updateUserRole(customManager, "member-1", "MEMBER"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
