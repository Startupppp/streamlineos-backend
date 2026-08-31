import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  roleAssignments,
  roles,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { ROLE_RANK } from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { principalIsOrgOwner } from "../../common/auth/principal";

export type ModuleStandingLevel = "owner" | "admin" | "member" | "none";

export type ModuleStandingSource =
  | "org-owner"
  | "org-admin"
  | "module-ownership"
  | "module-role"
  | "membership"
  | "none";

export interface ModuleStanding {
  level: ModuleStandingLevel;
  source: ModuleStandingSource;
  canManageAccess: boolean;
  canTransferOwnership: boolean;
}

/**
 * The single statement of what each standing may do. Org Owner is the
 * documented break-glass over actual Module Owner authority; Org Admin and
 * Module Admin administer access but never inherit the ownership lifecycle.
 */
const STANDING: Readonly<Record<ModuleStandingSource, ModuleStanding>> = {
  "org-owner": {
    level: "owner",
    source: "org-owner",
    canManageAccess: true,
    canTransferOwnership: true,
  },
  "module-ownership": {
    level: "owner",
    source: "module-ownership",
    canManageAccess: true,
    canTransferOwnership: true,
  },
  "org-admin": {
    level: "admin",
    source: "org-admin",
    canManageAccess: true,
    canTransferOwnership: true,
  },
  "module-role": {
    level: "admin",
    source: "module-role",
    canManageAccess: true,
    canTransferOwnership: false,
  },
  membership: {
    level: "member",
    source: "membership",
    canManageAccess: false,
    canTransferOwnership: false,
  },
  none: {
    level: "none",
    source: "none",
    canManageAccess: false,
    canTransferOwnership: false,
  },
};

export interface ModuleAuthorityFacts {
  isModuleOwner: boolean;
  isModuleAdmin: boolean;
}

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

async function resolveAuthoritySource(
  db: Db,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<ModuleStandingSource | null> {
  if (principalIsOrgOwner(actor.principal)) return "org-owner";
  if (await isStructuralOrgAdmin(db, actor)) return "org-admin";
  const facts = await resolveModuleAuthorityFacts(db, actor, moduleKey);
  if (facts.isModuleOwner) return "module-ownership";
  if (facts.isModuleAdmin) return "module-role";
  return null;
}

export async function resolveModuleManagementStanding(
  db: Db,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<ModuleStanding | null> {
  const source = await resolveAuthoritySource(db, actor, moduleKey);
  return source ? STANDING[source] : null;
}

export async function canTransferModuleOwnership(
  db: Db,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<boolean> {
  if (principalIsOrgOwner(actor.principal))
    return STANDING["org-owner"].canTransferOwnership;

  if (await isStructuralOrgAdmin(db, actor))
    return STANDING["org-admin"].canTransferOwnership;

  const ownerUserId = await resolveModuleOwnerUserId(db, actor.orgId, moduleKey);
  if (ownerUserId !== null && ownerUserId === actor.userId)
    return STANDING["module-ownership"].canTransferOwnership;

  return STANDING.none.canTransferOwnership;
}

