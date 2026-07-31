import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const EMPLOYEES_READ_PERMISSION = "hr:employees:read";

export async function resolveEmployeesScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(EMPLOYEES_READ_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(EMPLOYEES_READ_PERMISSION) ?? "none";
}
