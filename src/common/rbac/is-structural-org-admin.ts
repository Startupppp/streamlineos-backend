import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationMembers } from "../../db/schema";
import { ORG_MEMBER_ROLES } from "./org-roles";
import { principalIsOrgOwner } from "../auth/principal";
import type { Principal } from "../auth/principal";
import type { CurrentUserContext } from "../auth/backend-claims";

/** Minimal actor shape, so `CurrentUserContext` and bare `{orgId,userId}` pairs both satisfy it. */
export interface StructuralActor {
  orgId: string;
  userId: string;
  isOrgOwner: boolean;
  principal?: Principal;
}

/**
 * A machine credential never holds structural standing. It carries its issuer's
 * `role` and `isOrgOwner` so record-level checks can see the person behind it,
 * and reading either of those as standing would hand an admin's agent token the
 * admin's own authority. An actor with no principal is a bare `{orgId,userId}`
 * pair from a background sweep, which predates the union and is treated as human.
 */
function actsAsAHuman(principal: Principal | undefined): boolean {
  if (!principal) return true;
  return principal.kind === "human-session" || principal.kind === "personal-token";
}

export function isStructuralOrgAdminContext(
  actor: CurrentUserContext,
): boolean {
  if (!actsAsAHuman(actor.principal)) return false;
  return (
    principalIsOrgOwner(actor.principal) ||
    actor.role === ORG_MEMBER_ROLES.ORG_ADMIN
  );
}

/**
 * Org-admin status is STRUCTURAL: an active `organizationMembers` row that is
 * either the owner or carries the ORG_ADMIN role. It is never derived from
 * holding a permission key. Deriving it from `settings:manage` /
 * `settings:rbac:manage` is AC-04 — it turns any custom role carrying a
 * settings key into a parallel superuser (CLAUDE.md §21).
 */
export async function isStructuralOrgAdmin(
  db: Db,
  actor: StructuralActor,
): Promise<boolean> {
  if (!actsAsAHuman(actor.principal)) return false;
  if (actor.isOrgOwner) return true;

  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, actor.orgId),
      eq(organizationMembers.userId, actor.userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { isOwner: true, role: true },
  });
  if (!member) return false;

  return member.isOwner === true || member.role === ORG_MEMBER_ROLES.ORG_ADMIN;
}
