import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { leaveRequests } from "../../../db/schema";
import { applyScope } from "../../access/apply-scope";

export const LEAVES_PERMISSION = "hr:leaves:approve";

export async function resolveLeavesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (!isScopable(LEAVES_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(LEAVES_PERMISSION) ?? "none";
}

/** A derived approver is exclusive for scoped approvers; all-scope HR can override. */
export function leaveApprovalScope(
  scope: DataScope,
  orgId: string,
  actorUserId: string,
  actorMembershipId?: number | null,
): SQL {
  const approverMatch =
    actorMembershipId != null
      ? or(eq(leaveRequests.approverMembershipId, actorMembershipId), eq(leaveRequests.approverId, actorUserId))!
      : eq(leaveRequests.approverId, actorUserId);
  switch (scope) {
    case "all":
      return sql`true`;
    case "team":
      return and(
        approverMatch,
        applyScope(scope, orgId, actorUserId, {
          ownerColumn: leaveRequests.userId,
        }),
      )!;
    case "own":
      return approverMatch;
    case "none":
      return sql`false`;
    default: {
      const _exhaustive: never = scope;
      return sql`false`;
    }
  }
}
