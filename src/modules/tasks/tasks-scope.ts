import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";

export const TASKS_VIEW_PERMISSION = "crm:tasks:view";

/**
 * `crm:tasks:view` IS scopable, so testing it for mere presence collapsed `own`
 * and `team` into `all`: the owner predicate was dropped entirely and
 * `?assigneeId=<anyone>` returned that person's tasks.
 */
export async function resolveTasksViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(TASKS_VIEW_PERMISSION) ?? "none");
}
