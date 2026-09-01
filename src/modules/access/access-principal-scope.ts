import type { Principal } from "../../common/auth/principal";
import { assertNever } from "../../common/auth/principal";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import type { DataScope } from "./access.types";

type ResolveMembershipCapability = (isOrgOwner: boolean) => Promise<DataScope>;

function withinCeiling(ceiling: readonly string[], key: string): boolean {
  return isPersonalTokenPermissionDelegable(key) && ceiling.includes(key);
}

export async function resolvePrincipalScope(
  principal: Principal,
  permissionKey: string,
  resolveMembershipCapability: ResolveMembershipCapability,
): Promise<DataScope> {
  switch (principal.kind) {
    case "account-only":
      return "none";
    case "system-job":
      return principal.ceiling.includes(permissionKey) ? "all" : "none";
    case "human-session":
      return resolveMembershipCapability(principal.isOrgOwner);
    case "personal-token":
      if (!withinCeiling(principal.ceiling, permissionKey)) return "none";
      return resolveMembershipCapability(principal.isOrgOwner);
    case "agent-token":
      if (!withinCeiling(principal.ceiling, permissionKey)) return "none";
      return resolveMembershipCapability(false);
    default:
      return assertNever(principal);
  }
}
