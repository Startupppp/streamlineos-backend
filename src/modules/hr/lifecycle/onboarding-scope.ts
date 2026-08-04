import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const ONBOARDING_MANAGE_PERMISSION = "hr:onboarding:manage";

export async function resolveOnboardingManageScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(ONBOARDING_MANAGE_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ONBOARDING_MANAGE_PERMISSION) ?? "none";
}
