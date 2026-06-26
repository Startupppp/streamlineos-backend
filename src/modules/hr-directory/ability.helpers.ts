import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";

export function userCan(u: CurrentUserContext, verb: string, subject: string): boolean {
  return defineAbilityFor({
    isPlatformAdmin: u.isPlatformAdmin,
    isOrgOwner: u.isOrgOwner,
    permissions: u.permissions,
    enabledModules: u.enabledModules,
  }).can(verb, subject);
}
