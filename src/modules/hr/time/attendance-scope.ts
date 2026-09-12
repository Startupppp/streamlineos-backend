import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { attendance } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";

export type AttendanceStatus = "OFFLINE" | "PRESENT" | "ON_BREAK" | "CHECKED_OUT";

export const ATTENDANCE_PERMISSION = "hr:attendance:manage";

export async function resolveAttendanceScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<ScopedRead> {
  if (!isScopable(ATTENDANCE_PERMISSION)) return ScopedRead.of(currentUser.orgId, currentUser.userId, "none");
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return ScopedRead.of(currentUser.orgId, currentUser.userId, resolved.get(ATTENDANCE_PERMISSION) ?? "none");
}

/** A user with attendance:view always retains self-service read access. */
export async function resolveAttendanceReadScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<ScopedRead> {
  const manageScope = await resolveAttendanceScope(access, currentUser);
  return manageScope.denied ? ScopedRead.of(currentUser.orgId, currentUser.userId, "own") : manageScope;
}

export function attendanceMemberScope(
  actorMembershipId?: number | null,
  ownerColumn: PgColumn = attendance.userMembershipId,
): OwnershipScope {
  return { own: actorMembershipId == null ? sql`false` : eq(ownerColumn, actorMembershipId) };
}
