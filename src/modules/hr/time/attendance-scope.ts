import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const ATTENDANCE_PERMISSION = "hr:attendance:manage";

export async function resolveAttendanceScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(ATTENDANCE_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ATTENDANCE_PERMISSION) ?? "none";
}
