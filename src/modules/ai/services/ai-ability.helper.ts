import { defineAbilityFor, type AppAbility } from "../../../common/rbac/abilities.factory";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export function abilityFor(user: CurrentUserContext): AppAbility {
  return defineAbilityFor({
    isPlatformAdmin: user.isPlatformAdmin,
    isOrgOwner: user.isOrgOwner,
    permissions: user.permissions,
    enabledModules: user.enabledModules,
  });
}
