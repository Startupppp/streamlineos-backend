import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const TIMESHEETS_VIEW_PERMISSION = "build:timesheets:view";
export const TIMESHEETS_MANAGE_PERMISSION = "build:timesheets:manage";

export async function resolveTimesheetsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);

  if (isScopable(TIMESHEETS_MANAGE_PERMISSION)) {
    const manageScope = resolved.get(TIMESHEETS_MANAGE_PERMISSION);
    if (manageScope && manageScope !== "none") return manageScope;
  } else if (resolved.has(TIMESHEETS_MANAGE_PERMISSION)) {
    return "all";
  }

  if (resolved.has(TIMESHEETS_VIEW_PERMISSION)) return "own";
  return "none";
}
