import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationMembers, roleAssignments, roles } from "../../db/schema";
import { ROLE_RANK } from "./grantability";

export interface ActorRankContext {
  bestRank: number;
  allowedModules: Set<string> | null;
}

export async function resolveActorRankContext(
  db: Db,
  orgId: string,
  userId: string,
): Promise<ActorRankContext> {
  const now = new Date();
  const rows = await db
    .select({ rank: roles.rank, moduleKey: roles.moduleKey })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(eq(roleAssignments.roleId, roles.id), eq(roles.orgId, orgId)),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, roleAssignments.orgId),
        eq(organizationMembers.id, roleAssignments.organizationMembershipId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, now)),
      ),
    )
    .orderBy(asc(roleAssignments.id))
    .limit(100);

  if (rows.length === 0)
    return { bestRank: ROLE_RANK.FUNCTIONAL, allowedModules: null };

  let bestRank: number = ROLE_RANK.FUNCTIONAL;
  for (const row of rows) {
    if (row.rank < bestRank) bestRank = row.rank;
  }

  const topRankRoles = rows.filter((r) => r.rank === bestRank);
  if (topRankRoles.some((r) => r.moduleKey === null))
    return { bestRank, allowedModules: null };

  return {
    bestRank,
    allowedModules: new Set(
      topRankRoles
        .map((r) => r.moduleKey)
        .filter((m): m is string => m !== null),
    ),
  };
}
