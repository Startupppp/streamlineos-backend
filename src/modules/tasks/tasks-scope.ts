import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";

export const TASKS_VIEW_PERMISSION = "crm:tasks:view";

/**
 * `crm:tasks:view` IS scopable, so testing it for mere presence collapsed `own`
 * and `team` into `all`: the owner predicate was dropped entirely and
 * `?assigneeId=<anyone>` returned that person's tasks. The gate is the resolved
 * DataScope, not the key sitting beside `tasks:read` in the same roles.
 */
export async function resolveTasksViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TASKS_VIEW_PERMISSION) ?? "none";
}
