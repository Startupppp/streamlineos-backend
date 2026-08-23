import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isPlanGatedModule } from "../../common/rbac/module-vocabulary";
import { moduleAvailability } from "../../common/rbac/module-availability";
import { moduleOf } from "./access.service";
import type { AuthResult, DataScope } from "./access.types";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";

export interface AccessResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
  getUserDeniedModules?: (orgId: string, userId: string) => Promise<Set<string>>;
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
  const avail = await moduleAvailability(
    {
      isCoreModule: (key) => !isPlanGatedModule(key),
      getModuleMap: async (orgId) => ({
        [moduleKey]: await access.isModuleEnabled(orgId, moduleKey),
      }),
      getUserDeniedModules: access.getUserDeniedModules
        ? (orgId, uid) => access.getUserDeniedModules!(orgId, uid)
        : async () => new Set<string>(),
      getPlanLockedModules: async () => [],
    },
    ctx.orgId,
    ctx.userId,
    moduleKey,
  );
  if (!avail.available) return { allow: false, scope: "none", reason: "NO_MODULE" };

  if (ctx.isOrgOwner) return { allow: true, scope: "all" };

  const resolved = await access.resolveUserPermissions(ctx.orgId, ctx.userId);

  const scope = resolved.get(permissionKey);
  if (!scope || scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  const tokenScopes = ctx.tokenScopes;
  const granted: string[] = [];
  for (const [key, grantedScope] of resolved) {
    if (grantedScope === "none") continue;
    if (
      tokenScopes &&
      (!isPersonalTokenPermissionDelegable(key) || !tokenScopes.includes(key))
    )
      continue;
    granted.push(key);
  }
  return { allow: true, scope, permissions: granted };
}
