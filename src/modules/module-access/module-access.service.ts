import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { auditLogs, moduleOwnerships, organizationMembers, rolePermissionGrants, roles, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { moduleAccessDenied } from "./module-access-errors";
import { resolveActorRankContext } from "./module-access.helpers";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import {
  ACCESS_MANAGED_MODULES,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type Permission,
} from "../rbac/permissions";
import type { AuditLogQuery, SetModuleRolePermissionsInput } from "./dto/module-access.schemas";

const MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);
const ORG_ADMIN_KEY = "settings:rbac:manage";
const PERM_DIFF_CAP = 50;

function moduleOf(permissionKey: string): string {
  return permissionKey.split(":")[0] ?? permissionKey;
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
    if (actor.isOrgOwner) return;

    const resolved = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const isOrgAdmin = (resolved.get(ORG_ADMIN_KEY) ?? "none") !== "none";
    if (isOrgAdmin) return;

    const scope = resolved.get(`${moduleKey}:access:${action}`);
    if (!scope || scope === "none") {
      throw moduleAccessDenied(action);
    }
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

  private async fetchRoles(orgId: string, moduleKey: string): Promise<ModuleRoleView[]> {
    const catalog = this.moduleCatalogKeys(moduleKey);

    const orgRoles = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .orderBy(asc(roles.name))
      .limit(100);

    const grants = await this.db
      .select({
        roleId: rolePermissionGrants.roleId,
        permissionKey: rolePermissionGrants.permissionKey,
        scope: rolePermissionGrants.scope,
      })
      .from(rolePermissionGrants)
      .where(eq(rolePermissionGrants.orgId, orgId))
      .limit(10000);

    const moduleGrantsByRole = new Map<
      number,
      { permissionKey: string; scope: DataScope }[]
    >();
    const rolesWithAnyGrant = new Set<number>();
    for (const grant of grants) {
      rolesWithAnyGrant.add(grant.roleId);
      if (!catalog.has(grant.permissionKey)) continue;
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

    const deduped = new Map<string, DataScope>();
    for (const item of input.items) {
      if (!catalog.has(item.permissionKey)) {
        throw new BadRequestException(
          `Permission "${item.permissionKey}" is not part of the ${moduleKey} module`,
        );
      }
      deduped.set(item.permissionKey, item.scope);
    }

    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    if (role.isSystem) {
      throw new ForbiddenException("System roles cannot be edited");
    }

    if (!actor.isOrgOwner) {
      const [resolved, { bestRank, allowedModules }] = await Promise.all([
        this.access.resolveUserPermissions(actor.orgId, actor.userId),
        resolveActorRankContext(this.db, actor.orgId, actor.userId),
      ]);
      const isOrgAdmin = (resolved.get(ORG_ADMIN_KEY) ?? "none") !== "none";
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

    let permDiff: { added: string[]; removed: string[]; truncated: boolean } = { added: [], removed: [], truncated: false };

    await this.db.transaction(async (tx): Promise<void> => {
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
        )
        .limit(2000);

      const base = new Map<string, DataScope>();
      if (existingGrants.length > 0) {
        for (const grant of existingGrants) base.set(grant.permissionKey, grant.scope);
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
      const rawTruncated = addedKeys.length > PERM_DIFF_CAP || removedKeys.length > PERM_DIFF_CAP;
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
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
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
    if (!membership) throw new ForbiddenException("Not an active member of this organization");

    const [resolved, ownerRow] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      this.db
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
            eq(moduleOwnerships.orgId, actor.orgId),
            eq(moduleOwnerships.moduleKey, moduleKey),
          ),
        )
        .limit(1),
    ]);

    const permissions = Array.from(resolved.entries())
      .filter(([key]) => key.startsWith(`${moduleKey}:`))
      .map(([key, scope]) => ({ key, scope }));

    const isModuleAdmin = (resolved.get(`${moduleKey}:access:manage`) ?? "none") !== "none"
      || (resolved.get(`${moduleKey}:access:view`) ?? "none") !== "none";

    return {
      permissions,
      isOrgOwner: actor.isOrgOwner,
      isModuleOwner: ownerRow[0]?.userId === actor.userId,
      isModuleAdmin,
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
      metadata: Record<string, unknown> | null;
      ipAddress: string | null;
      createdAt: string;
    }[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
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

    const data = rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorUserId: r.actorUserId,
      actorName: r.actorName ?? r.actorEmail ?? r.actorUserId,
      actorEmail: r.actorEmail ?? "",
      targetId: r.targetId,
      targetType: r.targetType,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
    }));

    return {
      data,
      pagination: { page, pageSize: limit, total, totalPages: total > 0 ? Math.ceil(total / limit) : 0 },
    };
  }
}
