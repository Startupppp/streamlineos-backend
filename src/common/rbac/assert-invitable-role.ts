import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ORG_MEMBER_ROLES, isOrgMemberRole } from "./org-roles";

export interface InviteRoleActor {
  isOrgOwner: boolean;
  isOrgAdmin: boolean;
}

/** Guards the structural role an invite (or direct membership creation) may carry. */
export function assertInvitableRole(actor: InviteRoleActor, role: string): void {
  if (!isOrgMemberRole(role)) {
    throw new BadRequestException(
      `Invalid role "${role}". Expected one of: ${ORG_MEMBER_ROLES.OWNER}, ${ORG_MEMBER_ROLES.ORG_ADMIN}, ${ORG_MEMBER_ROLES.MEMBER}.`,
    );
  }

  if (role === ORG_MEMBER_ROLES.OWNER) {
    throw new ForbiddenException(
      "A member cannot be invited as owner. Use the ownership transfer flow instead.",
    );
  }

  if (role === ORG_MEMBER_ROLES.ORG_ADMIN) {
    if (!actor.isOrgOwner && !actor.isOrgAdmin) {
      throw new ForbiddenException(
        "Only an organization owner or administrator can grant the administrator role.",
      );
    }
  }
}
