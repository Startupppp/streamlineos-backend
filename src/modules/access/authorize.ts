import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { moduleAvailability, moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { moduleOf } from "./access.service";
import type { AuthResult, DataScope } from "./access.types";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import { isCoreModuleKey } from "./entitlements.service";

export interface AccessResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
  getModuleState?: (orgId: string, moduleKey: string) => Promise<boolean | undefined>;
  getUserDeniedModules?: (orgId: string, userId: string) => Promise<Set<string>>;
  getPlanLockedModules?: (orgId: string) => Promise<readonly string[]>;
}

export async function authorize(
  access: AccessResolver,
  ctx: CurrentUserContext | null,
  permissionKey: string,
): Promise<AuthResult> {
  if (!ctx) return { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

  if (
    ctx.tokenScopes &&
    (!isPersonalTokenPermissionDelegable(permissionKey) ||
      !ctx.tokenScopes.includes(permissionKey))
  ) {
    return { allow: false, scope: "none", reason: "FORBIDDEN" };
  }

  const moduleKey = moduleOf(permissionKey);
  const getPlanLockedModules = access.getPlanLockedModules;
  const getModuleState = access.getModuleState?.bind(access);
  const getUserDeniedModules = access.getUserDeniedModules;
  const avail = await moduleAvailability(
    moduleAvailabilityResolver(
      {
        isCoreModule: isCoreModuleKey,
        getModuleMap: async (orgId: string): Promise<Record<string, boolean>> => {
          const state = getModuleState
            ? await getModuleState(orgId, moduleKey)
            : await access.isModuleEnabled(orgId, moduleKey);
          return state === undefined ? {} : { [moduleKey]: state };
        },
        getPlanLockedModules: getPlanLockedModules
          ? (orgId: string) => getPlanLockedModules(orgId)
          : async (): Promise<readonly string[]> => [],
      },
      getUserDeniedModules
        ? { getUserDeniedModules: (orgId: string, uid: string) => getUserDeniedModules(orgId, uid) }
        : undefined,
    ),
    ctx.orgId,
    ctx.userId,
    moduleKey,
  );
  if (!avail.available) return { allow: false, scope: "none", reason: "NO_MODULE" };

  if (ctx.isOrgOwner) return { allow: true, scope: "all" };

  const resolved = await access.resolveUserPermissions(ctx.orgId, ctx.userId);

  const scope = resolved.get(permissionKey);
  if (!scope || scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}
