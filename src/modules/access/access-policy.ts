import {
  ACCESS_MANAGED_MODULES,
  ALL_PERMISSION_NAMES,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
} from "../rbac/permissions";
import { isPlanGatedModule, namespaceOf } from "../../common/rbac/module-vocabulary";
import {
  isPlatformOnlyPermission,
  PLATFORM_ONLY_PERMISSION_KEYS,
} from "../../common/rbac/grantability";
import { isPlatformAdmin } from "../../common/rbac/platform-operators";
import type { DataScope } from "./access.types";
import { MODULE_CATALOG } from "./entitlements.service";

export const MANAGEABLE_MODULE_SET: ReadonlySet<string> = new Set(
  MODULE_CATALOG,
);

export const CATALOG_KEY_SET: ReadonlySet<string> = new Set(
  ALL_PERMISSION_NAMES,
);

const ACCESS_MANAGE_TO_VIEW_MAP: ReadonlyMap<string, string> = (() => {
  const permissionImplications = new Map<string, string>();
  for (const moduleKey of ACCESS_MANAGED_MODULES) {
    const managePermissionKey = `${moduleKey}:access:manage`;
    const viewPermissionKey = `${moduleKey}:access:view`;
    if (
      CATALOG_KEY_SET.has(managePermissionKey) &&
      CATALOG_KEY_SET.has(viewPermissionKey)
    ) {
      permissionImplications.set(managePermissionKey, viewPermissionKey);
    }
  }
  return permissionImplications;
})();

export const SCOPE_RANK: Record<DataScope, number> = {
  none: 0,
  own: 1,
  team: 2,
  all: 3,
};

export function broadest(
  leftScope: DataScope,
  rightScope: DataScope,
): DataScope {
  return SCOPE_RANK[leftScope] >= SCOPE_RANK[rightScope]
    ? leftScope
    : rightScope;
}

export interface DelegationRow {
  permissions: string[];
  status: string;
  startsAt: Date;
  endsAt: Date;
}

export function isActiveDelegation(
  delegation: DelegationRow,
  currentTime: Date,
): boolean {
  return (
    delegation.status === "ACTIVE" &&
    delegation.startsAt <= currentTime &&
    delegation.endsAt > currentTime
  );
}

export function isActiveAssignment(
  assignment: { expiresAt: Date | null },
  currentTime: Date,
): boolean {
  return assignment.expiresAt === null || assignment.expiresAt > currentTime;
}

export interface MembershipGateResult {
  active: boolean;
  isOwner: boolean;
}

export function evaluateMembershipGate(
  membership: { status: string; isOwner: boolean } | null | undefined,
): MembershipGateResult {
  if (!membership || membership.status !== "ACTIVE") {
    return { active: false, isOwner: false };
  }
  return { active: true, isOwner: membership.isOwner };
}

export const CATALOG_MODULES = Array.from(
  new Set(PERMISSIONS.map((permission) => namespaceOf(permission.name))),
);

export const EMPTY_DENIED_MODULES: ReadonlySet<string> = new Set<string>();

function employeeSelfServiceScope(permissionKey: string): DataScope {
  return permissionKey.startsWith("self:") ? "own" : "all";
}

export const EMPLOYEE_SELF_SERVICE_GRANTS: ReadonlyArray<{
  readonly permissionKey: string;
  readonly scope: DataScope;
}> = Object.freeze(
  (ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []).map((permissionKey) => ({
    permissionKey,
    scope: employeeSelfServiceScope(permissionKey),
  })),
);

/**
 * Every catalog key a member of *an organization* can hold, at scope `all`.
 *
 * Platform-only keys are excluded on purpose: they administer resources the
 * vendor owns globally, and this function is what the owner/org-admin
 * short-circuit returns. Including them let every customer administrator edit
 * and hard-delete the vendor's marketing blog, because a global table has no
 * tenant column to stop them at the data layer.
 */
export function allCatalogScopes(): Record<string, DataScope> {
  const catalogScopes: Record<string, DataScope> = {};
  for (const permission of PERMISSIONS) {
    if (isPlatformOnlyPermission(permission.name)) continue;
    catalogScopes[permission.name] = "all";
  }
  return catalogScopes;
}

/** The platform-only keys, held only by the deployment's own operators. */
export function platformCapabilityScopes(
  userId: string,
): Record<string, DataScope> {
  if (!isPlatformAdmin(userId)) return {};
  const scopes: Record<string, DataScope> = {};
  for (const key of PLATFORM_ONLY_PERMISSION_KEYS) scopes[key] = "all";
  return scopes;
}

export function deriveAccessViewImplication(
  permissionScopes: Record<string, DataScope>,
): void {
  for (const [managePermissionKey, viewPermissionKey] of
    ACCESS_MANAGE_TO_VIEW_MAP) {
    const manageScope = permissionScopes[managePermissionKey];
    if (!manageScope || manageScope === "none") continue;
    const existingScope = permissionScopes[viewPermissionKey];
    permissionScopes[viewPermissionKey] = existingScope
      ? broadest(existingScope, manageScope)
      : manageScope;
  }
}

export { isPlanGatedModule };

export function applyUniversalGrants(map: Map<string, DataScope>): Map<string, DataScope> {
  for (const grant of [...UNIVERSAL_MEMBER_PERMISSION_GRANTS, ...EMPLOYEE_SELF_SERVICE_GRANTS]) {
    const existing = map.get(grant.permissionKey);
    map.set(
      grant.permissionKey,
      existing ? broadest(existing, grant.scope) : grant.scope,
    );
  }
  return map;
}

export function stripDeniedModules(
  map: Map<string, DataScope>,
  denied: ReadonlySet<string>,
): void {
  if (denied.size === 0) return;
  for (const key of Array.from(map.keys())) {
    if (denied.has(namespaceOf(key))) map.delete(key);
  }
}
