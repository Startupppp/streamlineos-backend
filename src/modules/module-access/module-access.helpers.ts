import { ForbiddenException } from "@nestjs/common";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { moduleAccessDenied } from "./module-access-errors";
import { organizationMembers, roleAssignments, roles } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { ROLE_RANK } from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { resolveModuleManagementStanding } from "./module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";

export {
  resolveModuleOwnerUserId,
  resolveModuleAuthorityFacts,
} from "./module-standing";
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

interface ModuleAccessPolicyDeps {
  db: Db;
  isModuleEnabled: (orgId: string, moduleKey: string) => Promise<boolean>;
  resolveUserPermissions: (
    orgId: string,
    userId: string,
  ) => Promise<ReadonlyMap<string, DataScope>>;
}

export async function assertModuleAccessPolicy(
  deps: ModuleAccessPolicyDeps,
  actor: CurrentUserContext,
  moduleKey: string,
  action: "view" | "manage",
): Promise<void> {
  if (!(await deps.isModuleEnabled(actor.orgId, moduleKey)))
    throw new ForbiddenException(`The ${moduleKey} module is not enabled`);

  if (actor.isOrgOwner) return;

  if (action === "manage") {
    if (await hasModuleAccessManagementAuthority(deps.db, actor, moduleKey))
      return;

    throw moduleAccessDenied(action);
  }

  if (await isStructuralOrgAdmin(deps.db, actor)) return;

  const resolved = await deps.resolveUserPermissions(actor.orgId, actor.userId);
  const scope =
    resolved.get(`${moduleKey}:access:${action}`) ??
    resolved.get(`${moduleKey}:access:manage`);
  if (!scope || scope === "none") throw moduleAccessDenied(action);
}

export async function resolveActorRankContext(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ bestRank: number; allowedModules: Set<string> | null }> {
  const now = new Date();
  const rows = await db
    .select({ rank: roles.rank, moduleKey: roles.moduleKey })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(eq(roleAssignments.roleId, roles.id), eq(roles.orgId, orgId)),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, roleAssignments.orgId),
        eq(organizationMembers.id, roleAssignments.organizationMembershipId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
        or(
          isNull(roleAssignments.expiresAt),
          gt(roleAssignments.expiresAt, now),
        ),
      ),
    )
    .limit(100);

  if (rows.length === 0) {
    return { bestRank: ROLE_RANK.FUNCTIONAL, allowedModules: null };
  }

  let bestRank: number = ROLE_RANK.FUNCTIONAL;
  for (const row of rows) {
    if (row.rank < bestRank) bestRank = row.rank;
  }

  const topRankRoles = rows.filter((r) => r.rank === bestRank);
  if (topRankRoles.some((r) => r.moduleKey === null)) {
    return { bestRank, allowedModules: null };
  }

  const modules = new Set(
    topRankRoles.map((r) => r.moduleKey).filter((m): m is string => m !== null),
  );
  return { bestRank, allowedModules: modules };
}
