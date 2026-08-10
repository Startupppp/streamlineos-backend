import { ForbiddenException } from "@nestjs/common";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { moduleAccessDenied } from "./module-access-errors";
import {
  moduleOwnerships,
  organizationMembers,
  roleAssignments,
  roles,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { grantsOrgAdmin, ROLE_RANK } from "../../common/rbac/grantability";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";

export async function resolveModuleOwnerUserId(
  db: Db,
  orgId: string,
  moduleKey: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: organizationMembers.userId })
    .from(moduleOwnerships)
    .innerJoin(
      organizationMembers,
      and(
        eq(moduleOwnerships.orgId, organizationMembers.orgId),
        eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
      ),
    )
    .where(
      and(
        eq(moduleOwnerships.orgId, orgId),
        eq(moduleOwnerships.moduleKey, moduleKey),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

export interface ModuleAuthorityFacts {
  isModuleOwner: boolean;
  isModuleAdmin: boolean;
}

export async function resolveModuleAuthorityFacts(
  db: Db,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<ModuleAuthorityFacts> {
  const now = new Date();
  const [ownerUserId, moduleAdminRows] = await Promise.all([
    resolveModuleOwnerUserId(db, actor.orgId, moduleKey),
    db
      .select({ rank: roles.rank, moduleKey: roles.moduleKey })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .innerJoin(
        roles,
        and(
          eq(roles.id, roleAssignments.roleId),
          eq(roles.orgId, roleAssignments.orgId),
        ),
      )
      .where(
        and(
          eq(roleAssignments.orgId, actor.orgId),
          eq(organizationMembers.userId, actor.userId),
          eq(organizationMembers.status, "ACTIVE"),
          eq(roles.moduleKey, moduleKey),
          eq(roles.rank, ROLE_RANK.MODULE_ADMIN),
          or(
            isNull(roleAssignments.expiresAt),
            gt(roleAssignments.expiresAt, now),
          ),
        ),
      )
      .limit(1),
  ]);

  return {
    isModuleOwner: ownerUserId === actor.userId,
    isModuleAdmin: moduleAdminRows.some(
      (row) =>
        row.rank === ROLE_RANK.MODULE_ADMIN && row.moduleKey === moduleKey,
    ),
  };
}

/**
 * Write authority is intentionally structural. A module-scoped effective
 * `access:manage` grant does not manufacture Module Admin status. Org Admin is
 * the canonical reserved-key policy; Module Owner is the ownership row; and
 * Module Admin is an active, unexpired rank-20 assignment for this module.
 */
export async function hasModuleAccessManagementAuthority(
  db: Db,
  actor: CurrentUserContext,
  moduleKey: string,
  resolvedPermissions: ReadonlyMap<string, DataScope>,
): Promise<boolean> {
  if (actor.isOrgOwner || grantsOrgAdmin(resolvedPermissions)) return true;

  const authority = await resolveModuleAuthorityFacts(db, actor, moduleKey);
  return authority.isModuleOwner || authority.isModuleAdmin;
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

  const resolved = await deps.resolveUserPermissions(actor.orgId, actor.userId);

  if (action === "manage") {
    if (
      await hasModuleAccessManagementAuthority(
        deps.db,
        actor,
        moduleKey,
        resolved,
      )
    )
      return;

    throw moduleAccessDenied(action);
  }

  if (grantsOrgAdmin(resolved)) return;
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
