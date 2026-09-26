import { CACHE_KEYS } from "../../common/cache/cache-keys";
import type { CacheService } from "../../common/cache/cache.service";
import type { OrgHierarchyCacheService } from "../../common/cache/org-hierarchy-cache.service";
import { registerAfterCommit } from "../../common/tenant/tenant-context";

/**
 * After a reporting relationship commits, every read that walks the hierarchy is stale: the org
 * chart and headcount namespaces, and the employee list that shows each person's manager. Both
 * run after commit (BE-85: inline when there is no transaction to wait for).
 */
export async function invalidateReportingReads(
  hierarchyCache: Pick<OrgHierarchyCacheService, "invalidateAfterMutation">,
  cache: Pick<CacheService, "invalidateNamespace">,
  orgId: string,
): Promise<void> {
  await hierarchyCache.invalidateAfterMutation(orgId);
  const bustEmployees = () => cache.invalidateNamespace(CACHE_KEYS.hrEmployeesListNamespace(orgId));
  if (!registerAfterCommit(bustEmployees)) await bustEmployees();
}
