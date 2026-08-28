import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationMembers } from "../../db/schema";
import { ORG_MEMBER_ROLES } from "./org-roles";
import { principalIsOrgOwner } from "../auth/principal";
import type { CurrentUserContext } from "../auth/backend-claims";

/** Minimal actor shape, so `CurrentUserContext` and bare `{orgId,userId}` pairs both satisfy it. */
export interface StructuralActor {
  orgId: string;
  userId: string;
  isOrgOwner: boolean;
}

/**
 * Org-admin status is STRUCTURAL: an active `organizationMembers` row that is
 * either the owner or carries the ORG_ADMIN role. It is never derived from
 * holding a permission key. Deriving it from `settings:manage` /
 * `settings:rbac:manage` is AC-04 — it turns any custom role carrying a
 * settings key into a parallel superuser (CLAUDE.md §21).
 */
export function isStructuralOrgAdminContext(
  actor: CurrentUserContext,
): boolean {
  return (
    principalIsOrgOwner(actor.principal) ||
    actor.role === ORG_MEMBER_ROLES.ORG_ADMIN
  );
}

export async function isStructuralOrgAdmin(
  db: Db,
  actor: StructuralActor,
): Promise<boolean> {
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
