import { sql, type SQL } from "drizzle-orm";
import { okrGoals } from "../../db/schema";

export function goalsInManagedProductCondition(
  orgId: string,
  managedProductId: number,
): SQL {
  return sql`${okrGoals.projectId} IN (
    SELECT "goal_projects"."id"
    FROM "build"."projects" AS "goal_projects"
    WHERE "goal_projects"."org_id" = ${orgId}
      AND "goal_projects"."managed_product_id" = ${managedProductId}
      AND "goal_projects"."deleted_at" IS NULL
  )`;
}
