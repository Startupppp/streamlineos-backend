import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { moduleAccessDenied } from "./module-access-errors";
import { ACCESS_MANAGED_MODULES } from "../rbac/permissions";
import type { Db } from "../../db/drizzle.module";
import { resolveModuleManagementStanding } from "./module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";

export {
  resolveModuleOwnerUserId,
  resolveModuleAuthorityFacts,
} from "./module-standing";
export { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
export type { ModuleAuthorityFacts } from "./module-standing";

/**
 * Write authority is intentionally structural. A module-scoped effective
 * `access:manage` grant does not manufacture Module Admin status. Org Admin is
 * an active owner/ORG_ADMIN membership row — NOT the holder of a reserved
 * permission key, which would be AC-04 (CLAUDE.md §21); Module Owner is the
 * ownership row; and Module Admin is an active, unexpired rank-20 assignment
 * for this module.
 */
export async function hasModuleAccessManagementAuthority(
  db: Db,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<boolean> {
  const standing = await resolveModuleManagementStanding(db, actor, moduleKey);
  return standing?.canManageAccess ?? false;
}

const MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

export interface ModuleAccessPolicyDeps {
  db: Db;
  isModuleEnabled: (orgId: string, moduleKey: string) => Promise<boolean>;
  resolveUserPermissions: (
    orgId: string,
    userId: string,
  ) => Promise<ReadonlyMap<string, DataScope>>;
}

interface ModuleAccessPolicySource {
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
  resolveUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<ReadonlyMap<string, DataScope>>;
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
  };
}

export function assertManagedModule(moduleKey: string): void {
  if (!MANAGED_MODULES.has(moduleKey))
    throw new NotFoundException(
      `Access is not separately managed for module "${moduleKey}"`,
    );
}

export async function assertModuleEnabled(
  deps: Pick<ModuleAccessPolicyDeps, "isModuleEnabled">,
  orgId: string,
  moduleKey: string,
): Promise<void> {
  assertManagedModule(moduleKey);
  if (!(await deps.isModuleEnabled(orgId, moduleKey)))
    throw new ForbiddenException(`The ${moduleKey} module is not enabled`);
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
    if (await hasModuleAccessManagementAuthority(deps.db, actor, moduleKey))
      return;

    throw moduleAccessDenied(action);
  }

  const resolved = await deps.resolveUserPermissions(actor.orgId, actor.userId);
  const scope =
    resolved.get(`${moduleKey}:access:${action}`) ??
    resolved.get(`${moduleKey}:access:manage`);
  if (scope && scope !== "none") return;

  if (await hasModuleAccessManagementAuthority(deps.db, actor, moduleKey))
    return;

  throw moduleAccessDenied(action);
}

