import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  assertPermissionsGrantable,
  buildPermissionAdministeringModuleMap,
  isImmutableSystemRole,
  toGrantableSet,
  type RoleGrantTarget,
} from "../../../common/rbac/grantability";
import { resolveActorRankContext } from "../../../common/rbac/resolve-actor-rank";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { PERMISSIONS, UNIVERSAL_MEMBER_PERMISSIONS } from "../permissions";
import type { SetRolePermissionsInput } from "../dto/rbac.schemas";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));
const UNIVERSAL_PERMISSION_KEYS = new Set<string>(UNIVERSAL_MEMBER_PERMISSIONS);

/**
 * Writing a role's permissions, and everything that has to happen around it.
 *
 * Split from the reads because this is the half carrying the escalation rule
 * and its consequences: `assertGrantable` refuses a permission the actor does
 * not hold, `isImmutableSystemRole` refuses the roles nobody may edit, and
 * `invalidateRoleHolderSessions` is why a revoked permission stops working for
 * people already signed in. None of the three is exported — a caller changing
 * role permissions goes through `setRolePermissions`, which cannot skip any of
 * them.
 *
 * `getRole` arrives as a callback: it is shared with the read path, and a second
 * copy is how the two would come to disagree about which roles exist.
 */
/**
 * What `getRole` hands back. Spelled out rather than inferred because that read
 * stays on the service and reaches this file as a callback, and a callback needs
 * a return type — with `Promise<unknown>` every use of `existingRole.isSystem`
 * here stops typechecking.
 */
export type RoleRow = typeof roles.$inferSelect;

export interface RoleWriteDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: AuditService;
  readonly access: AccessService;
  readonly getRole: (orgId: string, roleId: number) => Promise<RoleRow>;
}

async function invalidateRoleHolderSessions(
  deps: RoleWriteDeps,
  orgId: string,
  roleId: number,
): Promise<void> {
  const assignees = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(roleAssignments)
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
        eq(roleAssignments.roleId, roleId),
      ),
    )
    .limit(500);
  await Promise.all(
    assignees.map((a) =>
      deps.cache.invalidate(CACHE_KEYS.userSession(a.userId)),
    ),
  );
}

async function assertGrantable(
  deps: RoleWriteDeps,
  actor: CurrentUserContext,
  requestedKeys: readonly string[],
  target?: RoleGrantTarget,
): Promise<void> {
  if (actor.isOrgOwner) return;
  const [resolved, { bestRank, allowedModules }] = await Promise.all([
    deps.access.resolveUserPermissions(actor.orgId, actor.userId),
    resolveActorRankContext(deps.db, actor.orgId, actor.userId),
  ]);
  const permMeta = buildPermissionAdministeringModuleMap(requestedKeys);
  assertPermissionsGrantable(
    {
      isOrgOwner: false,
      grantable: toGrantableSet(resolved),
      bestRank,
      allowedModules,
    },
    requestedKeys,
    target,
    permMeta,
  );
}

export async function setRolePermissions(
  deps: RoleWriteDeps,
  actor: CurrentUserContext,
  roleId: number,
  input: SetRolePermissionsInput,
): Promise<{ success: true; version: number }> {
  const existingRole = await deps.getRole(actor.orgId, roleId);

  if (isImmutableSystemRole(existingRole))
    throw new ForbiddenException(
      "Organization-level system roles cannot be modified",
    );

  const deduped = new Map<string, DataScope>();
  for (const item of input.items) {
    if (!CATALOG_KEYS.has(item.permissionKey)) {
      throw new BadRequestException(
        `Unknown permission key: ${item.permissionKey}`,
      );
    }
    if (UNIVERSAL_PERMISSION_KEYS.has(item.permissionKey)) continue;
    deduped.set(item.permissionKey, item.scope);
  }

  const target: RoleGrantTarget = {
    rank: existingRole.rank,
    moduleKey: existingRole.moduleKey,
  };
  await assertGrantable(deps, actor, Array.from(deduped.keys()), target);

  const nextVersion = existingRole.version + 1;

  await runInTenantTransaction(deps.db, async (tx): Promise<void> => {
    const updated = await tx
      .update(roles)
      .set({ version: nextVersion })
      .where(
        and(
          eq(roles.id, roleId),
          eq(roles.orgId, actor.orgId),
          eq(roles.version, input.version),
        ),
      )
      .returning({ id: roles.id });

    if (updated.length === 0) {
      throw new ConflictException(
        "This role was changed by someone else. Reload and try again.",
      );
    }

    await tx
      .delete(rolePermissionGrants)
      .where(
        and(
          eq(rolePermissionGrants.orgId, actor.orgId),
          eq(rolePermissionGrants.roleId, roleId),
        ),
      );

    if (deduped.size > 0) {
      await tx.insert(rolePermissionGrants).values(
        Array.from(deduped, ([permissionKey, scope]) => ({
          orgId: actor.orgId,
          roleId,
          permissionKey,
          scope,
        })),
      );
    }

    await bumpPermissionsVersion(tx, actor.orgId);
  }, { orgId: actor.orgId });

  await deps.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
  await invalidateRoleHolderSessions(deps, actor.orgId, roleId);

  deps.audit.log({
    action: "role.permissions.set",
    userId: actor.userId,
    orgId: actor.orgId,
    targetId: String(roleId),
    targetType: "role",
    metadata: { count: deduped.size },
  });

  return { success: true, version: nextVersion };
}
