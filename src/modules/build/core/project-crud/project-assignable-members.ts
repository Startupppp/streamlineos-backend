import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers, projectMembers } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";

export async function resolveProjectAssignableMemberships(
  db: DbOrTx,
  orgId: string,
  projectId: number,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: organizationMembers.userId,
      membershipId: organizationMembers.id,
    })
    .from(projectMembers)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.id, projectMembers.membershipId),
        eq(organizationMembers.orgId, projectMembers.orgId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    )
    .where(
      and(
        eq(projectMembers.orgId, orgId),
        eq(projectMembers.projectId, projectId),
        inArray(organizationMembers.userId, uniqueUserIds),
      ),
    );
  return new Map(rows.map((row) => [row.userId, row.membershipId]));
}
