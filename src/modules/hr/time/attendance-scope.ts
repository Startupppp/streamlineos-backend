import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { attendance } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export const ATTENDANCE_PERMISSION = "hr:attendance:manage";

export async function resolveAttendanceScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<DataScope> {
  if (!isScopable(ATTENDANCE_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return resolved.get(ATTENDANCE_PERMISSION) ?? "none";
}

/** A user with attendance:view always retains self-service read access. */
export async function resolveAttendanceReadScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<DataScope> {
  const manageScope = await resolveAttendanceScope(access, currentUser);
  return manageScope === "none" ? "own" : manageScope;
}

export function attendanceMemberScope(
  scope: DataScope,
  actorMembershipId?: number | null,
  ownerColumn: PgColumn = attendance.userMembershipId,
) {
  if (scope === "all") return sql`true`;
  if (actorMembershipId == null) return sql`false`;
  if (scope === "own" || scope === "team") {
    return eq(ownerColumn, actorMembershipId);
  }
  return sql`false`;
}
