import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { HR_PAYROLL_LIST_PERMISSION } from "./hr-payroll-permissions";

export async function resolveReimbursementsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(HR_PAYROLL_LIST_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(HR_PAYROLL_LIST_PERMISSION) ?? "none";
}
