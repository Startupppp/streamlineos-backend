import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const TIMESHEETS_MANAGE_PERMISSION = "build:timesheets:manage";

export async function resolveTimesheetsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(TIMESHEETS_MANAGE_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TIMESHEETS_MANAGE_PERMISSION) ?? "none";
}
