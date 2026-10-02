import { NotFoundException } from "@nestjs/common";
import { ModuleDisabledException } from "../../common/http/api-exceptions";
import { moduleAccessDenied } from "./module-access-errors";
import { ACCESS_MANAGED_MODULES } from "../rbac/permissions";
import type { Db } from "../../db/drizzle.module";
import { resolveModuleManagementStanding, resolveModuleStanding } from "./module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";

export {
  resolveModuleOwnerUserId,
  resolveModuleAuthorityFacts,
} from "./module-standing";
export { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";

/**
 * Write authority is intentionally structural. A module-scoped effective
 * `access:manage` grant does not manufacture Module Admin status. Org Admin is
 * an active owner/ORG_ADMIN membership row — NOT the holder of a reserved
 * permission key, which would be AC-04 (CLAUDE.md §21); Module Owner is the
 * ownership row; and Module Admin is an active, unexpired rank-20 assignment
 * for this module.
 */
const MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

export interface ModuleAccessPolicyDeps {
  db: Db;
  isModuleEnabled: (orgId: string, moduleKey: string) => Promise<boolean>;
  resolveUserPermissions: (
    orgId: string,
    userId: string,
  ) => Promise<ReadonlyMap<string, DataScope>>;
  getUserDeniedModules: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
}

interface ModuleAccessPolicySource {
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
  resolveUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<ReadonlyMap<string, DataScope>>;
  getUserDeniedModules(orgId: string, userId: string): Promise<ReadonlySet<string>>;
}

export function moduleAccessPolicyDeps(
  db: Db,
  access: ModuleAccessPolicySource,
): ModuleAccessPolicyDeps {
  return {
    db,
    isModuleEnabled: (orgId, key) => access.isModuleEnabled(orgId, key),
    resolveUserPermissions: (orgId, userId) =>
      access.resolveUserPermissions(orgId, userId),
    getUserDeniedModules: (orgId, userId) =>
      access.getUserDeniedModules(orgId, userId),
  };
}

export function assertManagedModule(moduleKey: string): void {
  if (!MANAGED_MODULES.has(moduleKey))
    throw new NotFoundException(
      `Access is not separately managed for module "${moduleKey}"`,
    );
}

export function assertRevocableMembershipStanding(
  membership: { role: string; isOwner: boolean },
): void {
  if (membership.isOwner || membership.role === ORG_MEMBER_ROLES.ORG_ADMIN)
    throw moduleAccessDenied("manage");
}

export async function assertModuleEnabled(
  deps: Pick<ModuleAccessPolicyDeps, "isModuleEnabled">,
  orgId: string,
  moduleKey: string,
): Promise<void> {
  assertManagedModule(moduleKey);
  if (!(await deps.isModuleEnabled(orgId, moduleKey)))
    throw new ModuleDisabledException(moduleKey, "org-disabled");
}

export async function assertModuleAccessPolicy(
  deps: ModuleAccessPolicyDeps,
  actor: CurrentUserContext,
  moduleKey: string,
  action: "view" | "manage",
): Promise<void> {
  await assertModuleEnabled(deps, actor.orgId, moduleKey);

  if (actor.isOrgOwner) return;

  if (action === "manage") {
    const standing = await resolveModuleManagementStanding(deps.db, actor, moduleKey);
    if (standing?.source === "module-ownership" || standing?.source === "module-role") {
      const denied = await deps.getUserDeniedModules(actor.orgId, actor.userId);
      if (denied.has(moduleKey))
        throw new ModuleDisabledException(moduleKey, "user-denied");
    }
    if (standing?.canManageAccess) return;

    throw moduleAccessDenied(action);
  }

  const resolved = await deps.resolveUserPermissions(actor.orgId, actor.userId);
  const standing = await resolveModuleStanding(deps.db, actor, moduleKey, resolved);
  if (standing.level !== "none" && standing.source !== "org-owner" && standing.source !== "org-admin") {
    const denied = await deps.getUserDeniedModules(actor.orgId, actor.userId);
    if (denied.has(moduleKey))
      throw new ModuleDisabledException(moduleKey, "user-denied");
  }
  if (standing.level !== "none") return;

  throw moduleAccessDenied(action);
}

