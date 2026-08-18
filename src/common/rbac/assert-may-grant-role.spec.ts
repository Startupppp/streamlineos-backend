import { ForbiddenException } from "@nestjs/common";
import {
  assertMayGrantRole,
  assertMayManageOrganizationMembership,
  type OrganizationMembershipAuthorityResolver,
} from "./assert-may-grant-role";

const ORG_ID = "org-1";
const USER_ID = "user-1";

function resolver(canManage: boolean): {
  access: OrganizationMembershipAuthorityResolver;
  canManageOrganizationMembership: jest.Mock;
} {
  const canManageOrganizationMembership = jest
    .fn()
    .mockResolvedValue(canManage);
  return {
    access: { canManageOrganizationMembership },
    canManageOrganizationMembership,
  };
}

describe("organization membership authority", () => {
  it("lets the organization owner manage memberships without a lookup", async () => {
    const { access, canManageOrganizationMembership } = resolver(false);

    await expect(
      assertMayManageOrganizationMembership(access, ORG_ID, {
        userId: USER_ID,
        isOrgOwner: true,
      }),
    ).resolves.toBeUndefined();
    expect(canManageOrganizationMembership).not.toHaveBeenCalled();
  });

  it("lets an active structural organization administrator manage memberships", async () => {
    const { access, canManageOrganizationMembership } = resolver(true);

    await expect(
      assertMayGrantRole(
        access,
        ORG_ID,
        { userId: USER_ID, isOrgOwner: false },
        "ORG_ADMIN",
      ),
    ).resolves.toBeUndefined();
    expect(canManageOrganizationMembership).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
    );
  });

  it("rejects a custom permission holder without structural authority", async () => {
    const { access } = resolver(false);

    await expect(
      assertMayGrantRole(
        access,
        ORG_ID,
        { userId: USER_ID, isOrgOwner: false },
        "MEMBER",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never creates a second owner outside ownership transfer", async () => {
    const { access } = resolver(true);

    await expect(
      assertMayGrantRole(
        access,
        ORG_ID,
        { userId: USER_ID, isOrgOwner: false },
        "OWNER",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
