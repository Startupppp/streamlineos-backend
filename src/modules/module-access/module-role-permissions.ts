import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import {
  assertPermissionsGrantable,
  buildPermissionAdministeringModuleMap,
  isImmutableSystemRole,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { administeringModuleOf, impliedViewKey } from "../../common/rbac/module-vocabulary";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { AccessService, SCOPE_RANK } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import { ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions";
import { resolveActorRankContext } from "./module-access.helpers";
import type { SetModuleRolePermissionsInput } from "./dto/module-access.schemas";

const PERM_DIFF_CAP = 50;
const ROLE_ASSIGNEE_PAGE_SIZE = 100;

interface RoleAssignee {
  membershipId: number;
  userId: string;
}

export async function invalidateRoleAssigneePages(
  fetchPage: (
    afterMembershipId: number | null,
    limit: number,
  ) => Promise<RoleAssignee[]>,
  invalidateSession: (userId: string) => Promise<void>,
): Promise<void> {
  let afterMembershipId: number | null = null;
  for (;;) {
    const page = await fetchPage(afterMembershipId, ROLE_ASSIGNEE_PAGE_SIZE);
    await Promise.all(page.map((assignee) => invalidateSession(assignee.userId)));
    if (page.length < ROLE_ASSIGNEE_PAGE_SIZE) return;
    const last = page[page.length - 1];
    if (!last) return;
    afterMembershipId = last.membershipId;
  }
}

function normalizeModulePermissionItems(
  catalog: ReadonlySet<string>,
  items: ReadonlyMap<string, DataScope>,
): Map<string, DataScope> {
  const normalized = new Map(items);
  for (const [permissionKey, scope] of items) {
    if (scope === "none") continue;
    const viewKey = impliedViewKey(catalog, permissionKey);
    if (!viewKey) continue;
    const existing = normalized.get(viewKey);
    normalized.set(
      viewKey,
      existing && SCOPE_RANK[existing] >= SCOPE_RANK[scope] ? existing : scope,
    );
  }
  return normalized;
}

interface ModuleRolePermissionsDeps {
  db: Db;
  access: AccessService;
  cache: CacheService;
  audit: AuditService;
}

export async function setModuleRolePermissions(
  deps: ModuleRolePermissionsDeps,
  actor: CurrentUserContext,
  moduleKey: string,
  roleId: number,
  input: SetModuleRolePermissionsInput,
  catalog: ReadonlySet<string>,
): Promise<{ success: true; version: number }> {
  const requested = new Map<string, DataScope>();
  for (const item of input.items) {
    if (!catalog.has(item.permissionKey)) {
      throw new BadRequestException(
        `Permission "${item.permissionKey}" is not part of the ${moduleKey} module`,
      );
    }
    requested.set(item.permissionKey, item.scope);
  }
  const deduped = normalizeModulePermissionItems(catalog, requested);
  const role = await deps.db.query.roles.findFirst({
    where: and(
      eq(roles.id, roleId),
      eq(roles.orgId, actor.orgId),
      eq(roles.moduleKey, moduleKey),
    ),
  });
  if (!role || role.moduleKey !== moduleKey) throw new NotFoundException("Role not found");
  if (isImmutableSystemRole(role)) {
    throw new ForbiddenException("Organization-level system roles cannot be edited");
  }
  if (!actor.isOrgOwner) {
    const [resolved, { bestRank, allowedModules }, isOrgAdmin] = await Promise.all([
      deps.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveActorRankContext(deps.db, actor.orgId, actor.userId),
      isStructuralOrgAdmin(deps.db, actor),
    ]);
    if (!isOrgAdmin) {
      assertPermissionsGrantable(
        {
          isOrgOwner: false,
          grantable: toGrantableSet(resolved),
          bestRank,
          allowedModules,
        },
        Array.from(deduped.keys()),
        { rank: role.rank, moduleKey: role.moduleKey },
        buildPermissionAdministeringModuleMap(Array.from(deduped.keys())),
      );
      const widened = Array.from(deduped)
        .filter(([key, scope]) => {
          const held = resolved.get(key);
          return held === undefined || SCOPE_RANK[scope] > SCOPE_RANK[held];
        })
        .map(([key]) => key);
      if (widened.length > 0) {
        const preview = widened.slice(0, 5).join(", ");
        throw new ForbiddenException(
          `You cannot grant a wider data scope than your own: ${preview}${
            widened.length > 5 ? ` (+${widened.length - 5} more)` : ""
          }`,
        );
      }
    }
  }
  const nextVersion = role.version + 1;
  let permDiff: { added: string[]; removed: string[]; truncated: boolean } = {
    added: [],
    removed: [],
    truncated: false,
  };
  await runInTenantTransaction(
    deps.db,
    async (tx): Promise<void> => {
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
        throw new ConflictException("This role was changed by someone else. Reload and try again.");
      }
      const existingGrants = await tx
        .select({ permissionKey: rolePermissionGrants.permissionKey, scope: rolePermissionGrants.scope })
        .from(rolePermissionGrants)
        .where(and(eq(rolePermissionGrants.orgId, actor.orgId), eq(rolePermissionGrants.roleId, roleId)));
      const base = new Map<string, DataScope>();
      if (existingGrants.length > 0) {
        for (const grant of existingGrants) base.set(grant.permissionKey, grant.scope);
      } else {
        for (const key of ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []) base.set(key, "all");
      }
      const oldModuleKeys = new Set(
        Array.from(base.keys()).filter((key) => administeringModuleOf(key) === moduleKey),
      );
      for (const key of Array.from(base.keys())) {
        if (administeringModuleOf(key) === moduleKey) base.delete(key);
      }
      for (const [key, scope] of deduped) base.set(key, scope);
      const addedKeys = Array.from(deduped.keys()).filter((key) => !oldModuleKeys.has(key));
      const removedKeys = Array.from(oldModuleKeys).filter((key) => !deduped.has(key));
      permDiff = {
        added: addedKeys.slice(0, PERM_DIFF_CAP),
        removed: removedKeys.slice(0, PERM_DIFF_CAP),
        truncated: addedKeys.length > PERM_DIFF_CAP || removedKeys.length > PERM_DIFF_CAP,
      };
      await tx
        .delete(rolePermissionGrants)
        .where(and(eq(rolePermissionGrants.orgId, actor.orgId), eq(rolePermissionGrants.roleId, roleId)));
      if (base.size > 0) {
        await tx.insert(rolePermissionGrants).values(
          Array.from(base, ([permissionKey, scope]) => ({ orgId: actor.orgId, roleId, permissionKey, scope })),
        );
      }
      await bumpPermissionsVersion(tx, actor.orgId);
    },
    { orgId: actor.orgId },
  );
  await deps.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
  await runInTenantTransaction(
    deps.db,
    (tx) =>
      invalidateRoleAssigneePages(
        (afterMembershipId, limit) => {
          const conditions = [eq(roleAssignments.orgId, actor.orgId), eq(roleAssignments.roleId, roleId)];
          if (afterMembershipId !== null) {
            conditions.push(gt(roleAssignments.organizationMembershipId, afterMembershipId));
          }
          return tx
            .select({ membershipId: roleAssignments.organizationMembershipId, userId: organizationMembers.userId })
            .from(roleAssignments)
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.orgId, roleAssignments.orgId),
                eq(organizationMembers.id, roleAssignments.organizationMembershipId),
              ),
            )
            .where(and(...conditions))
            .orderBy(asc(roleAssignments.organizationMembershipId))
            .limit(limit);
        },
        (userId) => deps.cache.invalidate(CACHE_KEYS.userSession(userId)),
      ),
    { orgId: actor.orgId },
  );
  deps.audit.log({
    action: "module_access.role_permissions_set",
    userId: actor.userId,
    orgId: actor.orgId,
    targetId: String(roleId),
    targetType: "role",
    metadata: {
      moduleKey,
      roleName: role.name,
      added: permDiff.added,
      removed: permDiff.removed,
      truncated: permDiff.truncated,
    },
  });
  return { success: true, version: nextVersion };
}
