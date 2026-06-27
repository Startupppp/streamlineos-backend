import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isInternalModule, moduleOf } from "./access.service";
import type { AuthResult, DataScope } from "./access.types";

export interface AccessResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
  getModuleEnabled(ctx: CurrentUserContext, moduleKey: string): boolean;
}

export async function authorize(
  access: AccessResolver,
  ctx: CurrentUserContext | null,
  permissionKey: string,
): Promise<AuthResult> {
  if (!ctx) return { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return { allow: true, scope: "all" };

  const moduleKey = moduleOf(permissionKey);
  if (!isInternalModule(moduleKey) && !access.getModuleEnabled(ctx, moduleKey)) {
    return { allow: false, scope: "none", reason: "NO_MODULE" };
  }

  const resolved = await access.resolveUserPermissions(ctx.orgId, ctx.userId);
  const scope = resolved.get(permissionKey);
  if (!scope || scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}

export async function requirePermission(
  access: AccessResolver,
  ctx: CurrentUserContext | null,
  permissionKey: string,
): Promise<DataScope> {
  const result = await authorize(access, ctx, permissionKey);
  if (!result.allow) {
    if (result.reason === "UNAUTHENTICATED") throw new UnauthorizedException("Unauthorized");
    if (result.reason === "NO_MODULE") {
      throw new ForbiddenException("Module not available on this plan");
    }
    throw new ForbiddenException("Permission denied");
  }
  return result.scope;
}
