import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isInternalModule, moduleOf } from "./access.service";
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

  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return { allow: true, scope: "all" };

  const moduleKey = moduleOf(permissionKey);
  if (!isInternalModule(moduleKey) && !(await access.isModuleEnabled(ctx.orgId, moduleKey))) {
    return { allow: false, scope: "none", reason: "NO_MODULE" };
  }

  const resolved = await access.resolveUserPermissions(ctx.orgId, ctx.userId);
  const scope = resolved.get(permissionKey);
  if (!scope || scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}

