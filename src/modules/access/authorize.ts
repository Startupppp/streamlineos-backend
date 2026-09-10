import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AuthContext } from "../../common/auth/auth-context";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import type { AuthResult, DataScope } from "./access.types";
import type { ModuleAvailabilityResolver } from "../../common/rbac/module-availability";

export interface AccessScopeResolver {
  scopeFor(
    user: CurrentUserContext,
    key: string,
    ctx?: AuthContext,
  ): Promise<DataScope>;
}

export interface AccessResolver extends AccessScopeResolver {
  getModuleState(orgId: string, moduleKey: string): Promise<boolean | undefined>;
  buildModuleAvailabilityResolver: (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
    getDeniedModules?: (orgId: string, userId: string) => Promise<Set<string>>,
  ) => ModuleAvailabilityResolver;
}

export async function authorize(
  access: AccessScopeResolver,
  ctx: AuthContext | null,
  permissionKey: string,
): Promise<AuthResult> {
  if (!ctx) return { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

  // namespaceOf, never administeringModuleOf: Home administers `chat:*` and is always enabled, so that swap would keep `chat:*` live for an org with Chat disabled.
  const avail = await ctx.moduleAvailable(namespaceOf(permissionKey));
  if (!avail.available) return { allow: false, scope: "none", reason: "NO_MODULE" };

  const scope = await access.scopeFor(ctx.actor, permissionKey, ctx);
  if (scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}
