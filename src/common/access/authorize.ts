import { ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../auth/backend-claims";
import { PERMISSION_CATALOG, type PermissionTier } from "./catalog";

const TIER_ORDER: PermissionTier[] = ["STARTER", "GROWTH", "ENTERPRISE"];

function meetsMinTier(orgTier: string | undefined, minTier: PermissionTier): boolean {
  if (!orgTier) return true;
  const orgIdx = TIER_ORDER.indexOf(orgTier as PermissionTier);
  const minIdx = TIER_ORDER.indexOf(minTier);
  return orgIdx >= minIdx;
}

function hasPermission(permissions: string[], permissionKey: string): boolean {
  const [subject, verb] = permissionKey.split(":");
  const altKey = `${subject}:${verb}`;
  return permissions.includes(permissionKey) || permissions.includes(altKey);
}

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

  const catalogEntry = PERMISSION_CATALOG.find((p) => p.key === permission);

  const resolvedModule = requiredModule ?? catalogEntry?.module;
  if (resolvedModule && ctx.enabledModules && !ctx.enabledModules.includes(resolvedModule)) {
    return { allow: false, reason: "NO_MODULE", scope: "none", upgrade: resolvedModule };
  }

  if (catalogEntry && !meetsMinTier((ctx as unknown as Record<string, unknown>).orgTier as string | undefined, catalogEntry.minTier)) {
    return { allow: false, reason: "PLAN_UPGRADE", scope: "none", upgrade: catalogEntry.minTier };
  }

  if (ctx.isPlatformAdmin || ctx.isOrgOwner) {
    return { allow: true, scope: "all" };
  }

  if (!hasPermission(ctx.permissions, permission)) {
    return { allow: false, reason: "FORBIDDEN", scope: "none" };
  }

  return { allow: true, scope: catalogEntry?.scopable ? "own" : "all" };
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
