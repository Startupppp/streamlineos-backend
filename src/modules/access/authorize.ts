import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  moduleAvailability,
  moduleAvailabilityResolver,
} from "../../common/rbac/module-availability";
import { moduleOf } from "./access.service";
import type { AuthResult, DataScope } from "./access.types";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import { isCoreModuleKey } from "./entitlements.service";

export interface AccessResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
  /** Canonical core-module ownership is delegated by AccessService. */
  isCoreModule?: (moduleKey: string) => boolean;
  buildModuleAvailabilityResolver?: (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
  ) => import("../../common/rbac/module-availability").ModuleAvailabilityResolver;
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
  const getModuleMap = async (orgId: string): Promise<Record<string, boolean>> => {
    const state = getModuleState
      ? await getModuleState(orgId, moduleKey)
      : await access.isModuleEnabled(orgId, moduleKey);
    return state === undefined ? {} : { [moduleKey]: state };
  };

  // AccessService supplies the canonical service-owned resolver in production.
  // The compatibility path is for narrow legacy test doubles only; a missing
  // plan source fails closed instead of silently deleting the plan branch.
  const resolver = access.buildModuleAvailabilityResolver
    ? access.buildModuleAvailabilityResolver(getModuleMap)
    : moduleAvailabilityResolver(
        {
          isCoreModule: access.isCoreModule ?? isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: (orgId) => {
            if (!getPlanLockedModules) {
              throw new Error("AccessResolver must provide getPlanLockedModules");
            }
            return getPlanLockedModules(orgId);
          },
        },
        getUserDeniedModules
          ? { getUserDeniedModules: (orgId, uid) => getUserDeniedModules(orgId, uid) }
          : undefined,
      );

  const avail = await moduleAvailability(resolver, ctx.orgId, ctx.userId, moduleKey);
  if (!avail.available) return { allow: false, scope: "none", reason: "NO_MODULE" };

  if (ctx.isOrgOwner) return { allow: true, scope: "all" };

  const resolved = await access.resolveUserPermissions(ctx.orgId, ctx.userId);

  const scope = resolved.get(permissionKey);
  if (!scope || scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}
