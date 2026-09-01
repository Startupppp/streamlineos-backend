import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { leaveRequests } from "../../../db/schema";

export const LEAVES_PERMISSION = "hr:leaves:approve";

export async function resolveLeavesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (!isScopable(LEAVES_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(LEAVES_PERMISSION) ?? "none";
}

function employeeOwnerPredicate(actorMembershipId?: number | null): SQL {
  if (actorMembershipId == null) return sql`false`;
  return eq(leaveRequests.userMembershipId, actorMembershipId);
}

/** A derived approver is exclusive for scoped approvers; all-scope HR can override. */
export function leaveApprovalScope(
  scope: DataScope,
  actorMembershipId?: number | null,
): SQL {
  const approverMatch = actorMembershipId != null
    ? eq(leaveRequests.approverMembershipId, actorMembershipId)
    : sql`false`;
  switch (scope) {
    case "all":
      return sql`true`;
    case "team":
      return and(
        approverMatch,
        employeeOwnerPredicate(actorMembershipId),
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

export function leaveEmployeeScope(
  scope: DataScope,
  actorMembershipId?: number | null,
): SQL {
  switch (scope) {
    case "all":
      return sql`true`;
    case "team":
    case "own":
      return employeeOwnerPredicate(actorMembershipId);
    case "none":
      return sql`false`;
    default: {
      const _exhaustive: never = scope;
      return sql`false`;
    }
  }
}
