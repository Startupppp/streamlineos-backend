import { and, eq, isNull } from "drizzle-orm";
import { organizationMembers, projectMembers, projects } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export async function getAccessibleProjectIds(
  db: Db,
  user: CurrentUserContext,
): Promise<number[]> {
  if (user.isOrgOwner) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, projects.orgId),
        eq(organizationMembers.id, projectMembers.membershipId),
      ),
    )
    .where(
      and(
        eq(projects.orgId, user.orgId),
        eq(organizationMembers.userId, user.userId),
        eq(organizationMembers.status, "ACTIVE"),
        isNull(projects.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}
