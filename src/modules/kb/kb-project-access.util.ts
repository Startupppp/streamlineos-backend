import { and, eq, isNull } from "drizzle-orm";
import { projectMembers, projects } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export async function getAccessibleProjectIds(
  db: Db,
  user: CurrentUserContext,
): Promise<number[]> {
  if (user.isOrgOwner) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(
      and(
        eq(projects.orgId, user.orgId),
        eq(projectMembers.userId, user.userId),
        isNull(projects.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}
