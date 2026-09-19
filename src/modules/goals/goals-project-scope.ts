import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { okrGoals, projects } from "../../db/schema";

function goalsInProjectsMatching(condition: SQL | undefined): SQL {
  return sql`${okrGoals.projectId} IN (SELECT ${projects.id} FROM ${projects} WHERE ${condition})`;
}

export function goalsInPmWorkspaceCondition(
  orgId: string,
  pmWorkspaceId: string,
): SQL {
  return goalsInProjectsMatching(
    and(
      eq(projects.orgId, orgId),
      eq(projects.pmWorkspaceId, pmWorkspaceId),
      isNull(projects.deletedAt),
    ),
  );
}

export function goalsInManagedProductCondition(
  orgId: string,
  managedProductId: number,
): SQL {
  return goalsInProjectsMatching(
    and(
      eq(projects.orgId, orgId),
      eq(projects.managedProductId, managedProductId),
      isNull(projects.deletedAt),
    ),
  );
}
