import { and, asc, eq, inArray } from "drizzle-orm";
import {
  isCompatibilityRelationAvailable,
  type CompatibilityDb,
} from "../../../../common/db/expand-contract-compat";
import { onboardingTaskDependencies } from "../../../../db/schema/hr/onboarding-task-dependencies";

export async function loadOnboardingTaskDependencies(
  database: CompatibilityDb,
  organizationId: string,
  onboardingTaskIds: readonly number[],
): Promise<Map<number, number[]>> {
  const uniqueOnboardingTaskIds = [...new Set(onboardingTaskIds)];
  if (
    uniqueOnboardingTaskIds.length === 0 ||
    !(await isCompatibilityRelationAvailable(
      database,
      "public.onboarding_task_dependencies",
    ))
  )
    return new Map();

  const dependencyRows = await database
    .select({
      onboardingTaskId: onboardingTaskDependencies.onboardingTaskId,
      prerequisiteTaskId: onboardingTaskDependencies.prerequisiteTaskId,
    })
    .from(onboardingTaskDependencies)
    .where(
      and(
        eq(onboardingTaskDependencies.organizationId, organizationId),
        inArray(onboardingTaskDependencies.onboardingTaskId, uniqueOnboardingTaskIds),
      ),
    )
    .orderBy(
      asc(onboardingTaskDependencies.onboardingTaskId),
      asc(onboardingTaskDependencies.sortOrder),
    )
    .limit(10_000);

  const dependenciesByTaskId = new Map<number, number[]>();
  for (const dependencyRow of dependencyRows) {
    const prerequisiteTaskIds =
      dependenciesByTaskId.get(dependencyRow.onboardingTaskId) ?? [];
    prerequisiteTaskIds.push(dependencyRow.prerequisiteTaskId);
    dependenciesByTaskId.set(dependencyRow.onboardingTaskId, prerequisiteTaskIds);
  }
  return dependenciesByTaskId;
}
