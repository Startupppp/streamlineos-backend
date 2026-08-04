import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { grantsOrgAdmin } from "../../common/rbac/grantability";
import { isPlanGatedModule } from "../../common/rbac/module-vocabulary";
import { moduleOf } from "./access.service";
import type { AuthResult, DataScope } from "./access.types";

export interface AccessResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
}

export async function authorize(
  access: AccessResolver,
  ctx: CurrentUserContext | null,
  permissionKey: string,
): Promise<AuthResult> {
  if (!ctx) return { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

  if (ctx.tokenScopes && !ctx.tokenScopes.includes(permissionKey)) {
    return { allow: false, scope: "none", reason: "FORBIDDEN" };
  }

  const moduleKey = moduleOf(permissionKey);
  if (isPlanGatedModule(moduleKey) && !(await access.isModuleEnabled(ctx.orgId, moduleKey))) {
    return { allow: false, scope: "none", reason: "NO_MODULE" };
  }

  if (ctx.isOrgOwner) return { allow: true, scope: "all" };

  const resolved = await access.resolveUserPermissions(ctx.orgId, ctx.userId);

  if (grantsOrgAdmin(resolved)) {
    return { allow: true, scope: "all" };
  }

  const scope = resolved.get(permissionKey);
  if (!scope || scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  const tokenScopes = ctx.tokenScopes;
  const granted: string[] = [];
  for (const [key, grantedScope] of resolved) {
    if (grantedScope === "none") continue;
    if (tokenScopes && !tokenScopes.includes(key)) continue;
    granted.push(key);
  }
  return { allow: true, scope, permissions: granted };
}
