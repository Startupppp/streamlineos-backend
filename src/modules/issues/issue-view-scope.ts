import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { isScopable } from "../rbac/permissions";

/**
 * How much of the three record types a caller may see.
 *
 * `crm:issues:view` is scopable for the same reason `crm:deals:read` is: a
 * member restricted to their own work should see their own tasks and the
 * complaints they own, not the whole organisation's. Resolved the same way deals
 * resolve it, rather than by a second mechanism that can disagree.
 *
 * `none` on a miss, never `all`. A scope the resolver could not find is a
 * question about authority, and the safe answer to a question about authority is
 * no.
 */

/**
 * The one method this needs, rather than the whole of `AccessService`.
 *
 * `AccessService` satisfies it structurally so the controller passes it
 * unchanged, and a test supplies a four-line object instead of standing a
 * caching, database-backed service up to answer one question — which is the
 * difference between this rule being asserted and being assumed.
 */
export interface PermissionScopeReader {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
}
export const ISSUES_VIEW_PERMISSION = "crm:issues:view";

export async function resolveIssuesViewScope(
  access: PermissionScopeReader,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(ISSUES_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ISSUES_VIEW_PERMISSION) ?? "none";
}
