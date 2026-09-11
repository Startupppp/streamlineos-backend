import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { eq, sql, type SQL } from "drizzle-orm";
import { leaveRequests } from "../../../db/schema";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";
import type { DataScope } from "../../access/access.types";

export const LEAVES_PERMISSION = "hr:leaves:approve";

export async function resolveLeavesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (!isScopable(LEAVES_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "none");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(LEAVES_PERMISSION) ?? "none");
}

function employeeOwnerPredicate(actorMembershipId?: number | null): SQL {
  if (actorMembershipId == null) return sql`false`;
  return eq(leaveRequests.userMembershipId, actorMembershipId);
}

/** A derived approver is exclusive for scoped approvers; all-scope HR can override. */
export function leaveApprovalScope(actorMembershipId?: number | null): OwnershipScope {
  const approverMatch = actorMembershipId != null
    ? eq(leaveRequests.approverMembershipId, actorMembershipId)
    : sql`false`;
  return { own: approverMatch };
}

export function leaveEmployeeScope(actorMembershipId?: number | null): OwnershipScope {
  return { own: employeeOwnerPredicate(actorMembershipId) };
}

/** A candidate approver's own coverage, resolved from their permissions rather than the caller's. */
export function leaveApproverRead(
  orgId: string,
  candidateUserId: string,
  permissions: ReadonlyMap<string, DataScope>,
): ScopedRead {
  return ScopedRead.of(orgId, candidateUserId, permissions.get(LEAVES_PERMISSION) ?? "none");
}
