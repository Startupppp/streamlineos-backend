import { ForbiddenException } from "@nestjs/common";
import { assertInvitableRole } from "./assert-invitable-role";

export interface OrganizationMembershipAuthorityResolver {
  canManageOrganizationMembership(
    orgId: string,
    userId: string,
  ): Promise<boolean>;
}

export async function assertMayManageOrganizationMembership(
  access: OrganizationMembershipAuthorityResolver,
  orgId: string,
  actor: { userId: string; isOrgOwner: boolean },
): Promise<void> {
  if (actor.isOrgOwner) return;

  const canManage = await access.canManageOrganizationMembership(
    orgId,
    actor.userId,
  );
  if (!canManage) {
    throw new ForbiddenException(
      "Only an organization owner or administrator can manage organization memberships.",
    );
  }
}

export async function assertMayGrantRole(
  access: OrganizationMembershipAuthorityResolver,
  orgId: string,
  actor: { userId: string; isOrgOwner: boolean },
  role: string,
): Promise<void> {
  await assertMayManageOrganizationMembership(access, orgId, actor);
  assertInvitableRole({
    isOrgOwner: actor.isOrgOwner,
    isOrgAdmin: !actor.isOrgOwner,
  }, role);
}
