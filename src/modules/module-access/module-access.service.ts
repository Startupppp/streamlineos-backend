import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  organizationMembers,
  rolePermissionGrants,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
  resolveModuleAuthorityFacts,
} from "./module-access.helpers";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type Permission,
} from "../rbac/permissions";
import type {
  AuditLogQuery,
  SetModuleRolePermissionsInput,
} from "./dto/module-access.schemas";
import {
  listModuleAuditLog,
  type ModuleAuditLogDeps,
  type ModuleAuditLogPage,
} from "./lib/module-audit-log";
import { setModuleRolePermissions } from "./module-role-permissions";

// `impliedViewKey` is re-exported rather than defined here: the copy that runs
// is the one `normalizeModulePermissionItems` calls, and a second definition in
// this file was what `implied-view-key.spec.ts` was actually testing.
export { impliedViewKey, invalidateRoleAssigneePages } from "./module-role-permissions";

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

  moduleCatalog(moduleKey: string): Permission[] {
    assertManagedModule(moduleKey);
    return PERMISSIONS.filter((p) => administeringModuleOf(p.name) === moduleKey);
  }

  private moduleCatalogKeys(moduleKey: string): Set<string> {
    return new Set(this.moduleCatalog(moduleKey).map((p) => p.name));
  }

  async assertModuleAccess(
    actor: CurrentUserContext,
    moduleKey: string,
    action: "view" | "manage",
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
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
    return setModuleRolePermissions(
      { db: this.db, access: this.access, cache: this.cache, audit: this.audit },
      actor,
      moduleKey,
      roleId,
      input,
      this.moduleCatalogKeys(moduleKey),
    );
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
    assertManagedModule(moduleKey);

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

    // Reported as independent facts, not as a single standing: an org owner or
    // org admin can also be the module owner, and the ownership tab keys on it.
    const [resolved, moduleAuthority, isOrgAdmin] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveModuleAuthorityFacts(this.db, actor, moduleKey),
      isStructuralOrgAdmin(this.db, actor),
    ]);

    const permissions = Array.from(resolved.entries())
      .filter(([key]) => administeringModuleOf(key) === moduleKey)
      .map(([key, scope]) => ({ key, scope }));

    return {
      permissions,
      isOrgOwner: actor.isOrgOwner,
      isOrgAdmin,
      ...moduleAuthority,
    };
  }

  private get auditLogDeps(): ModuleAuditLogDeps {
    return {
      db: this.db,
      assertModuleAccess: (actor, moduleKey, action) =>
        this.assertModuleAccess(actor, moduleKey, action),
    };
  }

  /**
   * The module's access-change history. Lives in `lib/module-audit-log.ts`,
   * which runs the `view` gate above before it reads anything.
   */
  async getAuditLog(
    actor: CurrentUserContext,
    moduleKey: string,
    query: AuditLogQuery,
  ): Promise<ModuleAuditLogPage> {
    return listModuleAuditLog(this.auditLogDeps, actor, moduleKey, query);
  }
}
