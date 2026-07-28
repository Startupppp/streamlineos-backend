import { and, eq } from "drizzle-orm";
import { organizationMembers, roleAssignments, roles } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { ROLE_RANK } from "../../common/rbac/grantability";

export async function resolveActorRankContext(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ bestRank: number; allowedModules: Set<string> | null }> {
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
    .where(and(eq(roleAssignments.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(100);

  if (rows.length === 0) {
    return { bestRank: ROLE_RANK.FUNCTIONAL, allowedModules: null };
  }

  let bestRank: number = ROLE_RANK.FUNCTIONAL;
  for (const row of rows) {
    if (row.rank < bestRank) bestRank = row.rank;
  }

  const topRankRoles = rows.filter((r) => r.rank === bestRank);
  if (topRankRoles.some((r) => r.moduleKey === null)) {
    return { bestRank, allowedModules: null };
  }

  const modules = new Set(
    topRankRoles.map((r) => r.moduleKey).filter((m): m is string => m !== null),
  );
  return { bestRank, allowedModules: modules };
}
