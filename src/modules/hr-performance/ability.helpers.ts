import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export function canManagePerformance(u: CurrentUserContext): boolean {
  return defineAbilityFor(u).can("manage", "hr:performance");
}

export function canManageDocuments(u: CurrentUserContext): boolean {
  return defineAbilityFor(u).can("manage", "hr:documents");
}
