import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import {
  groupRoleAssignments,
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  assertKnownPermissionKeys,
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  isImmutableSystemRole,
  toGrantableSet,
  type RoleGrantTarget,
} from "../../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../../common/rbac/is-structural-org-admin";
import { resolveActorRankContext } from "../../../common/rbac/resolve-actor-rank";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import { PERMISSIONS } from "../permissions";
import type { UpdateRoleInput } from "../dto/rbac.schemas";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));

/**
 * Editing and removing a role that already exists in the organisation.
 *
 * This is the half where the actor supplies the content, so it is the half that
 * can escalate: `assertGrantable` refuses any key the actor does not already
 * hold at a rank and module they are allowed to grant from, and it is NOT
 * exported — updateRole is the only way in, so a caller cannot reach the write
 * while skipping the check. The other refusals are of the same kind:
 * isImmutableSystemRole protects the org-level system roles from any edit,
 * deleteRole needs structural org-admin standing rather than a permission key,
 * and a role with assignments still attached fails with 409 rather than
 * silently orphaning them. Both operations bump the permissions version inside
 * their own transaction, which is what makes the change visible to the next
 * request.
 *
 * Seeding from the fixed catalog (lib/role-template-seeding.ts) is deliberately
 * NOT here: nothing about those rows is caller-supplied, so there is nothing to
 * escalate and they never consult grantability at all.
 */
export interface RoleMutationDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly access: AccessService;
}

async function assertGrantable(
  deps: RoleMutationDeps,
  actor: CurrentUserContext,
  requestedKeys: readonly string[],
  target?: RoleGrantTarget,
): Promise<void> {
  if (actor.isOrgOwner) return;
  const [resolved, { bestRank, allowedModules }] = await Promise.all([
    deps.access.resolveUserPermissions(actor.orgId, actor.userId),
    resolveActorRankContext(deps.db, actor.orgId, actor.userId),
  ]);
  const permMeta = buildPermissionModuleMap(requestedKeys);
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

export async function updateRole(
  deps: RoleMutationDeps,
  actor: CurrentUserContext,
  roleId: number,
  input: UpdateRoleInput,
): Promise<{ success: true }> {
  await runInTenantTransaction(
    deps.db,
    async (tx): Promise<void> => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
      });
      if (!existing) throw new NotFoundException("Role not found");

      if (
        isImmutableSystemRole(existing) &&
        (input.name !== undefined || input.permissions !== undefined)
      ) {
        throw new ForbiddenException(
          "Organization-level system roles cannot be modified",
        );
      }

      if (input.permissions !== undefined) {
        assertKnownPermissionKeys(input.permissions, CATALOG_KEYS);
        const target: RoleGrantTarget = {
          rank: existing.rank,
          moduleKey: existing.moduleKey,
        };
        await assertGrantable(deps, actor, input.permissions, target);
      }

      const updateData: {
        updatedAt: Date;
        name?: string;
      } = {
        updatedAt: new Date(),
      };
      if (input.name) updateData.name = input.name;

      await tx
        .update(roles)
        .set(updateData)
        .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));

      if (input.permissions !== undefined) {
        await tx
          .delete(rolePermissionGrants)
          .where(
            and(
              eq(rolePermissionGrants.orgId, actor.orgId),
              eq(rolePermissionGrants.roleId, roleId),
            ),
          );
        if (input.permissions.length > 0) {
          await tx.insert(rolePermissionGrants).values(
            input.permissions.map((permissionKey) => ({
              orgId: actor.orgId,
              roleId,
              permissionKey,
              scope: "all" as const,
            })),
          );
        }
      }

      await bumpPermissionsVersion(tx, actor.orgId);
    },
    { orgId: actor.orgId },
  );

  deps.audit.log({
    action: "role.changed",
    userId: actor.userId,
    orgId: actor.orgId,
    targetId: String(roleId),
    targetType: "role",
    metadata: { name: input.name, permissionsUpdated: !!input.permissions },
  });

  return { success: true };
}

export async function deleteRole(
  deps: RoleMutationDeps,
  actor: CurrentUserContext,
  roleId: number,
): Promise<{ success: true }> {
  if (!(await isStructuralOrgAdmin(deps.db, actor)))
    throw new ForbiddenException("Only org admins may delete roles");

  await runInTenantTransaction(
    deps.db,
    async (tx): Promise<void> => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
      });
      if (!existing) throw new NotFoundException("Role not found");
      if (existing.isSystem)
        throw new ForbiddenException("System roles cannot be deleted");

      const [{ value: directCount }] = await tx
        .select({ value: count() })
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.orgId, actor.orgId),
            eq(roleAssignments.roleId, roleId),
          ),
        );

      const [{ value: groupCount }] = await tx
        .select({ value: count() })
        .from(groupRoleAssignments)
        .where(
          and(
            eq(groupRoleAssignments.orgId, actor.orgId),
            eq(groupRoleAssignments.roleId, roleId),
          ),
        );

      const total = Number(directCount) + Number(groupCount);
      if (total > 0) {
        throw new ConflictException(
          `Cannot delete role — ${total} member assignment${total !== 1 ? "s are" : " is"} attached to it. Reassign them first.`,
        );
      }

      await tx
        .delete(roles)
        .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));
      await bumpPermissionsVersion(tx, actor.orgId);
    },
    { orgId: actor.orgId },
  );

  return { success: true };
}
