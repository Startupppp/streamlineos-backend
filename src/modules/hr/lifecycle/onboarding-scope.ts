import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { ScopedRead, type ScopeActor } from "../../access/scoped-read";

export const ONBOARDING_MANAGE_PERMISSION = "hr:onboarding:manage";

export async function resolveOnboardingManageScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(ONBOARDING_MANAGE_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "none");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(ONBOARDING_MANAGE_PERMISSION) ?? "none");
}

/** Every member may read their own onboarding documents; the admin list resolves the manage key instead. */
export function selfOnboardingRead(actor: ScopeActor): ScopedRead {
  return ScopedRead.of(actor.orgId, actor.userId, "own");
}

/** The onboarding task surface is unlocked by either key, so both are resolved from one permission read. */
export function onboardingTaskScopes(
  actor: ScopeActor,
  permissions: ReadonlyMap<string, DataScope>,
  employeesManagePermission: string,
): { onboardingScope: ScopedRead; employeeManageScope: ScopedRead } {
  return {
    onboardingScope: ScopedRead.of(
      actor.orgId,
      actor.userId,
      permissions.get(ONBOARDING_MANAGE_PERMISSION) ?? "none",
    ),
    employeeManageScope: ScopedRead.of(
      actor.orgId,
      actor.userId,
      permissions.get(employeesManagePermission) ?? "none",
    ),
  };
}
