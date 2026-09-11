import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { HR_PAYROLL_LIST_PERMISSION } from "./hr-payroll-permissions";

export function selfOnlyReimbursementsRead(orgId: string, userId: string): ScopedRead {
  return ScopedRead.of(orgId, userId, "own");
}

export async function resolveReimbursementsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const scope = u.isOrgOwner
    ? "all"
    : !isScopable(HR_PAYROLL_LIST_PERMISSION)
      ? "all"
      : (await access.resolveUserPermissions(u.orgId, u.userId)).get(HR_PAYROLL_LIST_PERMISSION) ?? "none";
  return ScopedRead.of(u.orgId, u.userId, scope);
}
