import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const REIMBURSEMENTS_PERMISSION = "hr:expenses:approve";

export async function resolveReimbursementsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(REIMBURSEMENTS_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(REIMBURSEMENTS_PERMISSION) ?? "none";
}
