import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { rolePermissionGrants, roles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import {
  assertPermissionsGrantable,
  toGrantableSet,
} from "../../common/rbac/grantability";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import {
  ACCESS_MANAGED_MODULES,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type Permission,
} from "../rbac/permissions";
import type { SetModuleRolePermissionsInput } from "./dto/module-access.schemas";

const MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);
const ORG_ADMIN_KEY = "settings:rbac:manage";

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
    if (actor.isOrgOwner || actor.isPlatformAdmin) return;

    const resolved = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const isOrgAdmin = (resolved.get(ORG_ADMIN_KEY) ?? "none") !== "none";
    if (isOrgAdmin) return;

    const scope = resolved.get(`${moduleKey}:access:${action}`);
    if (!scope || scope === "none") {
      throw new ForbiddenException(
        "You do not have access to manage this module's roles",
      );
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
    const catalog = this.moduleCatalogKeys(moduleKey);

    const orgRoles = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .where(eq(roles.orgId, actor.orgId))
      .orderBy(asc(roles.name))
      .limit(100);

    const grants = await this.db
      .select({
        roleId: rolePermissionGrants.roleId,
        permissionKey: rolePermissionGrants.permissionKey,
        scope: rolePermissionGrants.scope,
      })
      .from(rolePermissionGrants)
      .where(eq(rolePermissionGrants.orgId, actor.orgId))
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
  ): Promise<{ success: true }> {
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

    if (!actor.isOrgOwner && !actor.isPlatformAdmin) {
      const resolved = await this.access.resolveUserPermissions(
        actor.orgId,
        actor.userId,
      );
      assertPermissionsGrantable(
        { isOrgOwner: false, isPlatformAdmin: false, grantable: toGrantableSet(resolved) },
        Array.from(deduped.keys()),
      );
    }

    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    if (role.isSystem) {
      throw new ForbiddenException("System roles cannot be edited");
    }

    await this.db.transaction(async (tx): Promise<void> => {
      const existing = await tx
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

      // Materialize the role's current effective grants (explicit rows, else its slug
      // defaults), then replace ONLY this module's slice — non-module permissions are preserved.
      const base = new Map<string, DataScope>();
      if (existing.length > 0) {
        for (const grant of existing) base.set(grant.permissionKey, grant.scope);
      } else {
        for (const key of ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []) {
          base.set(key, "all");
        }
      }
      for (const key of Array.from(base.keys())) {
        if (moduleOf(key) === moduleKey) base.delete(key);
      }
      for (const [key, scope] of deduped) base.set(key, scope);

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
    return { success: true };
  }
}
