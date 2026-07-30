import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ORG_MEMBER_ROLES, isOrgMemberRole } from "./org-roles";

export interface InviteRoleActor {
  isOrgOwner: boolean;
  isOrgAdmin: boolean;
}

/**
 * Guards the structural role an invite (or direct membership creation) may carry.
 *
 * `POST /users/invite` is gated on `hr:employees:create`, so anyone who may add
 * an employee reaches this code. Without this check a free-text `role` would let
 * them mint an `ORG_ADMIN` — and since `syncStructuralRoleAssignment` now turns
 * that label into a real `role_assignments` grant, the escalation would be live
 * rather than cosmetic.
 *
 * Rules:
 *  - the role must be one of the three structural values;
 *  - `OWNER` is never invitable — an org has exactly one owner and ownership
 *    moves only through the transfer flow;
 *  - `ORG_ADMIN` may only be handed out by an owner, platform admin, or an
 *    existing org admin.
 */
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
