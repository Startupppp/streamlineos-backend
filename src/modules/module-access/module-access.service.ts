import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  isImmutableSystemRole,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { moduleAccessDenied } from "./module-access-errors";
import {
  assertModuleAccessPolicy,
  resolveActorRankContext,
  resolveModuleAuthorityFacts,
} from "./module-access.helpers";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import {
  ACCESS_MANAGED_MODULES,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type Permission,
} from "../rbac/permissions";
import type {
  AuditLogQuery,
  SetModuleRolePermissionsInput,
} from "./dto/module-access.schemas";

const MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);
const PERM_DIFF_CAP = 50;
const ROLE_ASSIGNEE_PAGE_SIZE = 100;
const SCOPE_RANK: Record<DataScope, number> = {
  none: 0,
  own: 1,
  team: 2,
  all: 3,
};

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
    await Promise.all(
      page.map((assignee) => invalidateSession(assignee.userId)),
    );
    if (page.length < ROLE_ASSIGNEE_PAGE_SIZE) return;
    const last = page[page.length - 1];
    if (!last) return;
    afterMembershipId = last.membershipId;
  }
}

function moduleOf(permissionKey: string): string {
  return permissionKey.split(":")[0] ?? permissionKey;
}

function normalizeModulePermissionItems(
  catalog: ReadonlySet<string>,
  items: ReadonlyMap<string, DataScope>,
): Map<string, DataScope> {
  const normalized = new Map(items);
  for (const [permissionKey, scope] of items) {
    const [moduleKey, resource, action] = permissionKey.split(":");
    if (
      !moduleKey ||
      !resource ||
      !action ||
      action === "view" ||
      scope === "none"
    )
      continue;
    const viewKey = `${moduleKey}:${resource}:view`;
    if (!catalog.has(viewKey)) continue;
    const existing = normalized.get(viewKey);
    normalized.set(
      viewKey,
      existing && SCOPE_RANK[existing] >= SCOPE_RANK[scope] ? existing : scope,
    );
  }
  return normalized;
}

export interface ModuleRoleView {
  roleId: number;
  name: string;
  slug: string;
  isSystem: boolean;
  permissions: { permissionKey: string; scope: DataScope }[];
}

/**
 * Per-module Access (plan §7.3): lets a module's Admin (and Organization Owner/Admin)
 * view and manage the roles/permissions of THAT module only. Authorization is dynamic on
 * the route's moduleKey, so it is asserted in the service (`<module>:access:view|manage`,
 * owner/org-admin bypass) rather than via a static @RequirePermission. Writes are confined
 * to the module's own permission namespace and pass the same grantable-subset checks as the
 * global role editor, so a Module Admin can never escalate outside their module.
 */
@Injectable()
export class ModuleAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  private assertKnownModule(moduleKey: string): void {
    if (!MANAGED_MODULES.has(moduleKey)) {
      throw new NotFoundException(
        `Access is not separately managed for module "${moduleKey}"`,
      );
    }
  }

  moduleCatalog(moduleKey: string): Permission[] {
    this.assertKnownModule(moduleKey);
    return PERMISSIONS.filter((p) => moduleOf(p.name) === moduleKey);
  }

  private moduleCatalogKeys(moduleKey: string): Set<string> {
    return new Set(this.moduleCatalog(moduleKey).map((p) => p.name));
  }

  async assertModuleAccess(
    actor: CurrentUserContext,
    moduleKey: string,
    action: "view" | "manage",
  ): Promise<void> {
    this.assertKnownModule(moduleKey);
    await assertModuleAccessPolicy(
      {
        db: this.db,
        isModuleEnabled: (orgId, key) => this.access.isModuleEnabled(orgId, key),
        resolveUserPermissions: (orgId, userId) =>
          this.access.resolveUserPermissions(orgId, userId),
      },
      actor,
      moduleKey,
      action,
    );
  }

  async listCatalog(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<Permission[]> {
    await this.assertModuleAccess(actor, moduleKey, "view");
    return this.moduleCatalog(moduleKey);
  }

  async listRoles(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleRoleView[]> {
    await this.assertModuleAccess(actor, moduleKey, "view");
    const version = await this.access.getPermissionsVersion(actor.orgId);
    return this.cache.cached(
      CACHE_KEYS.moduleRolesList(actor.orgId, moduleKey, version),
      () => this.fetchRoles(actor.orgId, moduleKey),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchRoles(
    orgId: string,
    moduleKey: string,
  ): Promise<ModuleRoleView[]> {
    const catalog = this.moduleCatalogKeys(moduleKey);

    const orgRoles = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)))
      .orderBy(asc(roles.name))
      .limit(100);

    if (orgRoles.length === 0) return [];
    const roleIds = orgRoles.map((role) => role.id);
    const [grants, rolesWithGrantRows] = await Promise.all([
      this.db
        .select({
          roleId: rolePermissionGrants.roleId,
          permissionKey: rolePermissionGrants.permissionKey,
          scope: rolePermissionGrants.scope,
        })
        .from(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, orgId),
            inArray(rolePermissionGrants.roleId, roleIds),
            inArray(rolePermissionGrants.permissionKey, Array.from(catalog)),
          ),
        ),
      this.db
        .selectDistinct({ roleId: rolePermissionGrants.roleId })
        .from(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, orgId),
            inArray(rolePermissionGrants.roleId, roleIds),
          ),
        ),
    ]);

    const moduleGrantsByRole = new Map<
      number,
      { permissionKey: string; scope: DataScope }[]
    >();
    const rolesWithAnyGrant = new Set(
      rolesWithGrantRows.map((grant) => grant.roleId),
    );
    for (const grant of grants) {
      const list = moduleGrantsByRole.get(grant.roleId) ?? [];
      list.push({ permissionKey: grant.permissionKey, scope: grant.scope });
      moduleGrantsByRole.set(grant.roleId, list);
    }

    return orgRoles.map((role) => {
      let permissions = moduleGrantsByRole.get(role.id);
      if (!permissions && !rolesWithAnyGrant.has(role.id)) {
        permissions = (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? [])
          .filter((key) => catalog.has(key))
          .map((permissionKey) => ({
            permissionKey,
            scope: "all" as DataScope,
          }));
      }
      return {
        roleId: role.id,
        name: role.name,
        slug: role.slug,
        isSystem: role.isSystem,
        permissions: permissions ?? [],
      };
    });
  }

  async setRolePermissions(
    actor: CurrentUserContext,
    moduleKey: string,
    roleId: number,
    input: SetModuleRolePermissionsInput,
  ): Promise<{ success: true; version: number }> {
    await this.assertModuleAccess(actor, moduleKey, "manage");
    const catalog = this.moduleCatalogKeys(moduleKey);

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

    const role = await this.db.query.roles.findFirst({
      where: and(
        eq(roles.id, roleId),
        eq(roles.orgId, actor.orgId),
        eq(roles.moduleKey, moduleKey),
      ),
    });
    if (!role || role.moduleKey !== moduleKey) {
      throw new NotFoundException("Role not found");
    }
    if (isImmutableSystemRole(role)) {
      throw new ForbiddenException(
        "Organization-level system roles cannot be edited",
      );
    }

    if (!actor.isOrgOwner) {
      const [resolved, { bestRank, allowedModules }, isOrgAdmin] =
        await Promise.all([
          this.access.resolveUserPermissions(actor.orgId, actor.userId),
          resolveActorRankContext(this.db, actor.orgId, actor.userId),
          isStructuralOrgAdmin(this.db, actor),
        ]);
      if (!isOrgAdmin) {
        const permMeta = buildPermissionModuleMap(Array.from(deduped.keys()));
        assertPermissionsGrantable(
          {
            isOrgOwner: false,
            grantable: toGrantableSet(resolved),
            bestRank,
            allowedModules,
          },
          Array.from(deduped.keys()),
          { rank: role.rank, moduleKey: role.moduleKey },
          permMeta,
        );
      }
    }

    const nextVersion = role.version + 1;

    let permDiff: { added: string[]; removed: string[]; truncated: boolean } = {
      added: [],
      removed: [],
      truncated: false,
    };

    await runInTenantTransaction(
      this.db,
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
          throw new ConflictException(
            "This role was changed by someone else. Reload and try again.",
          );
        }

        const existingGrants = await tx
          .select({
            permissionKey: rolePermissionGrants.permissionKey,
            scope: rolePermissionGrants.scope,
          })
          .from(rolePermissionGrants)
          .where(
            and(
              eq(rolePermissionGrants.orgId, actor.orgId),
              eq(rolePermissionGrants.roleId, roleId),
            ),
          );

        const base = new Map<string, DataScope>();
        if (existingGrants.length > 0) {
          for (const grant of existingGrants)
            base.set(grant.permissionKey, grant.scope);
        } else {
          for (const key of ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []) {
            base.set(key, "all");
          }
        }

        const oldModuleKeys = new Set<string>(
          Array.from(base.keys()).filter((k) => moduleOf(k) === moduleKey),
        );

        for (const key of Array.from(base.keys())) {
          if (moduleOf(key) === moduleKey) base.delete(key);
        }
        for (const [key, scope] of deduped) base.set(key, scope);

        const addedKeys: string[] = [];
        const removedKeys: string[] = [];
        for (const key of deduped.keys()) {
          if (!oldModuleKeys.has(key)) addedKeys.push(key);
        }
        for (const key of oldModuleKeys) {
          if (!deduped.has(key)) removedKeys.push(key);
        }
        const rawTruncated =
          addedKeys.length > PERM_DIFF_CAP ||
          removedKeys.length > PERM_DIFF_CAP;
        permDiff = {
          added: addedKeys.slice(0, PERM_DIFF_CAP),
          removed: removedKeys.slice(0, PERM_DIFF_CAP),
          truncated: rawTruncated,
        };

        await tx
          .delete(rolePermissionGrants)
          .where(
            and(
              eq(rolePermissionGrants.orgId, actor.orgId),
              eq(rolePermissionGrants.roleId, roleId),
            ),
          );
        if (base.size > 0) {
          await tx.insert(rolePermissionGrants).values(
            Array.from(base, ([permissionKey, scope]) => ({
              orgId: actor.orgId,
              roleId,
              permissionKey,
              scope,
            })),
          );
        }
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    await runInTenantTransaction(
      this.db,
      (tx) =>
        invalidateRoleAssigneePages(
          (afterMembershipId, limit) => {
            const conditions = [
              eq(roleAssignments.orgId, actor.orgId),
              eq(roleAssignments.roleId, roleId),
            ];
            if (afterMembershipId !== null) {
              conditions.push(
                gt(roleAssignments.organizationMembershipId, afterMembershipId),
              );
            }
            return tx
              .select({
                membershipId: roleAssignments.organizationMembershipId,
                userId: organizationMembers.userId,
              })
              .from(roleAssignments)
              .innerJoin(
                organizationMembers,
                and(
                  eq(organizationMembers.orgId, roleAssignments.orgId),
                  eq(
                    organizationMembers.id,
                    roleAssignments.organizationMembershipId,
                  ),
                ),
              )
              .where(and(...conditions))
              .orderBy(asc(roleAssignments.organizationMembershipId))
              .limit(limit);
          },
          (userId) => this.cache.invalidate(CACHE_KEYS.userSession(userId)),
        ),
      { orgId: actor.orgId },
    );

    this.audit.log({
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

  async getCallerPermissions(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<{
    permissions: { key: string; scope: DataScope }[];
    isOrgOwner: boolean;
    isOrgAdmin: boolean;
    isModuleOwner: boolean;
    isModuleAdmin: boolean;
  }> {
    this.assertKnownModule(moduleKey);

    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, actor.userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership)
      throw new ForbiddenException("Not an active member of this organization");

    const [resolved, moduleAuthority, isOrgAdmin] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveModuleAuthorityFacts(this.db, actor, moduleKey),
      isStructuralOrgAdmin(this.db, actor),
    ]);

    const permissions = Array.from(resolved.entries())
      .filter(([key]) => key.startsWith(`${moduleKey}:`))
      .map(([key, scope]) => ({ key, scope }));

    return {
      permissions,
      isOrgOwner: actor.isOrgOwner,
      isOrgAdmin,
      ...moduleAuthority,
    };
  }

  async getAuditLog(
    actor: CurrentUserContext,
    moduleKey: string,
    { page, pageSize }: AuditLogQuery,
  ): Promise<{
    data: {
      id: number;
      action: string;
      actorUserId: string;
      actorName: string;
      actorEmail: string;
      targetId: string | null;
      targetType: string | null;
      targetName: string | null;
      metadata: Record<string, unknown> | null;
      ipAddress: string | null;
      createdAt: string;
    }[];
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  }> {
    await this.assertModuleAccess(actor, moduleKey, "view");

    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;

    const where = and(
      eq(auditLogs.orgId, actor.orgId),
      sql`${auditLogs.metadata}->>'moduleKey' = ${moduleKey}`,
    );

    const [totalResult, rows] = await Promise.all([
      this.db.select({ total: count() }).from(auditLogs).where(where),
      this.db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          actorUserId: auditLogs.userId,
          actorName: users.name,
          actorEmail: users.email,
          targetId: auditLogs.targetId,
          targetType: auditLogs.targetType,
          metadata: auditLogs.metadata,
          ipAddress: auditLogs.ipAddress,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(totalResult[0]?.total ?? 0);
    const targetUserIds = rows.flatMap((row) =>
      row.targetType === "user" && row.targetId ? [row.targetId] : [],
    );
    const targetRoleIds = rows.flatMap((row) => {
      if (row.targetType !== "role" || !row.targetId) return [];
      const roleId = Number(row.targetId);
      return Number.isInteger(roleId) ? [roleId] : [];
    });
    const [targetUsers, targetRoles] = await Promise.all([
      targetUserIds.length
        ? this.db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .where(
              and(
                eq(organizationMembers.orgId, actor.orgId),
                inArray(organizationMembers.userId, targetUserIds),
              ),
            )
        : [],
      targetRoleIds.length
        ? this.db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(
              and(
                eq(roles.orgId, actor.orgId),
                inArray(roles.id, targetRoleIds),
              ),
            )
        : [],
    ]);
    const userNames = new Map(
      targetUsers.map((user) => [user.id, user.name ?? user.email]),
    );
    const roleNames = new Map(targetRoles.map((role) => [role.id, role.name]));

    const data = rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorUserId: r.actorUserId,
      actorName: r.actorName ?? r.actorEmail ?? r.actorUserId,
      actorEmail: r.actorEmail ?? "",
      targetId: r.targetId,
      targetType: r.targetType,
      targetName:
        r.targetType === "user" && r.targetId
          ? (userNames.get(r.targetId) ?? null)
          : r.targetType === "role" && r.targetId
            ? (roleNames.get(Number(r.targetId)) ?? null)
            : null,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
    }));

    return {
      data,
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
    };
  }
}
