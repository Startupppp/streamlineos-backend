import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { organizationMembers } from "../../db/schema";
import { moduleScopedPermissions } from "../rbac/permissions";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export interface TargetMembership {
  id: number;
  userId: string;
  status: (typeof organizationMembers.$inferSelect)["status"];
}

export function moduleKeys(moduleKey: string): Set<string> {
  return new Set(moduleScopedPermissions(moduleKey));
}

/**
 * Resolves the target inside the actor's own organisation. A membership from
 * another tenant simply is not found here, so a cross-tenant grant is
 * unrepresentable rather than merely refused.
 */
export async function resolveTargetMembership(
  db: Db,
  orgId: string,
  membershipId: number,
): Promise<TargetMembership> {
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.id, membershipId),
    ),
    columns: { id: true, userId: true, status: true },
  });
  if (!member) throw new NotFoundException("Member not found");
  return { id: member.id, userId: member.userId, status: member.status };
}

/**
 * Widening capability needs a live membership, matching the module-access
 * path. Reading and revoking stay open on a suspended person on purpose, so
 * grants left behind can still be audited and cleared.
 */
export async function resolveActiveTargetMembership(
  db: Db,
  orgId: string,
  membershipId: number,
): Promise<TargetMembership> {
  const member = await resolveTargetMembership(db, orgId, membershipId);
  if (member.status !== "ACTIVE") {
    throw new BadRequestException(
      "Permissions can only be granted to active members",
    );
  }
  return member;
}

export async function resolveActorMembershipId(
  db: Db,
  actor: CurrentUserContext,
): Promise<number | null> {
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, actor.orgId),
      eq(organizationMembers.userId, actor.userId),
    ),
    columns: { id: true },
  });
  return member?.id ?? null;
}
