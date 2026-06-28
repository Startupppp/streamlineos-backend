import { ForbiddenException } from "@nestjs/common";
import { defineAbilityFor } from "../rbac/abilities.factory";
import type { CurrentUserContext } from "../auth/backend-claims";

export type DenyReason =
  | "NO_MODULE"
  | "PLAN_UPGRADE"
  | "SEAT_REQUIRED"
  | "LIMIT_REACHED"
  | "FORBIDDEN"
  | "NOT_FOUND";

export type DataScope = "all" | "team" | "own" | "none";

export interface AuthorizeInput {
  permission: string;
  resource?: string;
  requiredModule?: string;
}

export interface AuthorizeResult {
  allow: boolean;
  reason?: DenyReason;
  scope: DataScope;
  upgrade?: string;
}

export function authorize(ctx: CurrentUserContext, input: AuthorizeInput): AuthorizeResult {
  const { permission, requiredModule } = input;

  if (requiredModule && ctx.enabledModules && !ctx.enabledModules.includes(requiredModule)) {
    return { allow: false, reason: "NO_MODULE", scope: "none", upgrade: requiredModule };
  }

  if (ctx.isPlatformAdmin || ctx.isOrgOwner) {
    return { allow: true, scope: "all" };
  }

  const [subject, verb] = permission.split(":");
  const ability = defineAbilityFor({
    isPlatformAdmin: ctx.isPlatformAdmin,
    isOrgOwner: ctx.isOrgOwner,
    permissions: ctx.permissions,
    enabledModules: ctx.enabledModules,
  });

  if (!ability.can(verb ?? "manage", subject ?? permission)) {
    return { allow: false, reason: "FORBIDDEN", scope: "none" };
  }

  return { allow: true, scope: "own" };
}

export function requireAuthorize(ctx: CurrentUserContext, input: AuthorizeInput): DataScope {
  const result = authorize(ctx, input);
  if (!result.allow) {
    const msg =
      result.reason === "NO_MODULE"
        ? `Module not enabled: ${input.requiredModule}`
        : `Permission denied: ${input.permission}`;
    throw new ForbiddenException(msg);
  }
  return result.scope;
}
