import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";

export const PAYROLL_RUNS_VIEW_PERMISSION = "payroll:runs:view";

export async function resolvePayrollRunsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const scope = u.isOrgOwner
    ? "all"
    : !isScopable(PAYROLL_RUNS_VIEW_PERMISSION)
      ? "all"
      : (await access.resolveUserPermissions(u.orgId, u.userId)).get(PAYROLL_RUNS_VIEW_PERMISSION) ?? "none";
  return ScopedRead.of(u.orgId, u.userId, scope);
}
