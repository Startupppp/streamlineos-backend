import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, ilike, inArray, ne } from "drizzle-orm";
import { roleAssignments, rolePermissionGrants, roles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { assertPermissionsGrantable, ROLE_RANK, toGrantableSet } from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { getPostgresErrorCode } from "../../common/db/postgres-error";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import { ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions";
import type { CreateModuleGroupInput, RenameModuleGroupInput } from "./dto/module-access.schemas";
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";
import type { ModuleRoleGroup } from "./module-access-groups.types";
import { resolveActorRankContext } from "./module-access.helpers";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import type { CursorPage } from "../../common/pagination/cursor";
import { keysetAfterValue } from "../../common/pagination/keyset";

@Injectable()
export class ModuleAccessGroupCrudService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly groupPolicy: ModuleAccessGroupPolicyService,
  ) {}

  async listGroups(
    orgId: string,
    moduleKey: string,
    permissionsVersion: number,
    cursor?: string,
    limit = 100,
  ): Promise<CursorPage<ModuleRoleGroup>> {
    if (!cursor) {
      return this.cache.cached(
        CACHE_KEYS.moduleGroupsList(orgId, moduleKey, permissionsVersion),
        () => this.fetchGroups(orgId, moduleKey, undefined, limit),
        CACHE_TTL.VERY_LONG,
      );
    }
    return this.fetchGroups(orgId, moduleKey, cursor, limit);
  }

  private async fetchGroups(
    orgId: string,
    moduleKey: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<ModuleRoleGroup>> {
    const decoded = decodeCursor(cursor);
    const cursorCond = decoded ? keysetAfterValue(roles.name, roles.id, decoded) : undefined;

    const orgRoles = await this.db
      .select({ id: roles.id, name: roles.name, slug: roles.slug, isSystem: roles.isSystem, version: roles.version })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey), cursorCond))
      .orderBy(asc(roles.name), asc(roles.id))
      .limit(limit + 1);

    if (orgRoles.length === 0)
      return { data: [], pagination: { limit, hasMore: false, nextCursor: null } };

    const hasMore = orgRoles.length > limit;
    const pageRoles = hasMore ? orgRoles.slice(0, limit) : orgRoles;
    const data = await this.hydrateGroups(orgId, moduleKey, pageRoles);
    return buildCursorPage(data, limit, (group) => ({
      sortValue: group.name,
      id: String(group.id),
    }));
  }

  private async hydrateGroups(
    orgId: string,
    moduleKey: string,
    orgRoles: Array<{ id: number; name: string; slug: string; isSystem: boolean; version: number }>,
  ): Promise<ModuleRoleGroup[]> {
    if (orgRoles.length === 0) return [];
    const catalog = this.groupPolicy.permissionKeys(moduleKey);
    const roleIds = orgRoles.map((role) => role.id);
    const [memberCountRows, grantRows, rolesWithGrantRows] = await Promise.all([
      this.db.select({ roleId: roleAssignments.roleId, cnt: count() }).from(roleAssignments)
        .where(and(eq(roleAssignments.orgId, orgId), inArray(roleAssignments.roleId, roleIds)))
        .groupBy(roleAssignments.roleId),
      this.db.select({ roleId: rolePermissionGrants.roleId, permissionKey: rolePermissionGrants.permissionKey, scope: rolePermissionGrants.scope })
        .from(rolePermissionGrants)
        .where(and(eq(rolePermissionGrants.orgId, orgId), inArray(rolePermissionGrants.roleId, roleIds), inArray(rolePermissionGrants.permissionKey, Array.from(catalog)))),
      this.db.selectDistinct({ roleId: rolePermissionGrants.roleId }).from(rolePermissionGrants)
        .where(and(eq(rolePermissionGrants.orgId, orgId), inArray(rolePermissionGrants.roleId, roleIds))),
    ]);
    const memberCountById = new Map<number, number>(memberCountRows.map((row) => [row.roleId, Number(row.cnt)]));
    const moduleGrantsByRole = new Map<number, { permissionKey: string; scope: DataScope }[]>();
    const rolesWithAnyGrant = new Set<number>(rolesWithGrantRows.map((row) => row.roleId));
    for (const grant of grantRows) {
      const permissions = moduleGrantsByRole.get(grant.roleId) ?? [];
      permissions.push({ permissionKey: grant.permissionKey, scope: grant.scope });
      moduleGrantsByRole.set(grant.roleId, permissions);
    }
    return orgRoles.map((role) => {
      let permissions = moduleGrantsByRole.get(role.id);
      if (!permissions && !rolesWithAnyGrant.has(role.id)) {
        permissions = (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []).filter((key) => catalog.has(key)).map((permissionKey) => ({ permissionKey, scope: "all" as DataScope }));
      }
      return { id: role.id, name: role.name, isSystem: role.isSystem, version: role.version, memberCount: memberCountById.get(role.id) ?? 0, permissions: permissions ?? [] };
    });
  }

  private async fetchSingleGroup(orgId: string, moduleKey: string, groupId: number): Promise<ModuleRoleGroup | undefined> {
    const [row] = await this.db
      .select({ id: roles.id, name: roles.name, slug: roles.slug, isSystem: roles.isSystem, version: roles.version })
      .from(roles)
      .where(and(eq(roles.id, groupId), eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)))
      .limit(1);
    if (!row) return undefined;
    const [hydrated] = await this.hydrateGroups(orgId, moduleKey, [row]);
    return hydrated;
  }

  async createGroup(actor: CurrentUserContext, moduleKey: string, input: CreateModuleGroupInput): Promise<ModuleRoleGroup> {
    if (!actor.isOrgOwner) {
      const [resolved, isOrgAdmin] = await Promise.all([this.access.resolveUserPermissions(actor.orgId, actor.userId), isStructuralOrgAdmin(this.db, actor)]);
      if (!isOrgAdmin) {
        const { bestRank, allowedModules } = await resolveActorRankContext(this.db, actor.orgId, actor.userId);
        assertPermissionsGrantable({ isOrgOwner: false, grantable: toGrantableSet(resolved), bestRank, allowedModules }, [], { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey });
      }
    }
    const [existing] = await this.db.select({ id: roles.id }).from(roles)
      .where(and(eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey), ilike(roles.name, input.name))).limit(1);
    if (existing) throw new ConflictException(`A group named "${input.name}" already exists in this module`);
    const slug = `${moduleKey.toUpperCase()}_${input.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${Date.now()}`;
    const row = await runInTenantTransaction(this.db, async (tx) => {
      const [created] = await tx.insert(roles).values({ name: input.name, slug, orgId: actor.orgId, isSystem: false, moduleKey, rank: ROLE_RANK.MODULE_CUSTOM }).returning({ id: roles.id, name: roles.name, isSystem: roles.isSystem, version: roles.version });
      if (!created) throw new BadRequestException("Failed to create group");
      await bumpPermissionsVersion(tx, actor.orgId);
      return created;
    }, { orgId: actor.orgId }).catch((error: unknown) => {
      /*
       * `uniq_roles_org_module_name_ci` — (org_id, COALESCE(module_key, ''), LOWER(name)).
       * The name check above is a read followed by a write, so this is what answers when two
       * requests pass that check together. Drizzle leaves the SQLSTATE on `.cause`; a
       * `"code" in error` test against the wrapper never fired and the race answered 500.
       */
      if (getPostgresErrorCode(error) === "23505") throw new ConflictException(`A group named "${input.name}" already exists in this module`);
      throw error;
    });
    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    this.audit.log({ action: "module_access.group_created", userId: actor.userId, orgId: actor.orgId, targetId: String(row.id), targetType: "role", metadata: { moduleKey, name: row.name } });
    return { id: row.id, name: row.name, isSystem: row.isSystem, version: row.version, memberCount: 0, permissions: [] };
  }

  async renameGroup(actor: CurrentUserContext, moduleKey: string, groupId: number, input: RenameModuleGroupInput): Promise<ModuleRoleGroup> {
    const existing = await this.db.query.roles.findFirst({ where: and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)) });
    if (!existing) throw new NotFoundException("Group not found");
    if (existing.isSystem) throw new ForbiddenException("System groups cannot be renamed");
    const [nameConflict] = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey), ilike(roles.name, input.name), ne(roles.id, groupId))).limit(1);
    if (nameConflict) throw new ConflictException(`A group named "${input.name}" already exists in this module`);
    const [row] = await runInTenantTransaction(this.db, async (tx) => {
      const updated = await tx.update(roles).set({ name: input.name, updatedAt: new Date() }).where(and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey))).returning({ id: roles.id, name: roles.name, isSystem: roles.isSystem, version: roles.version });
      await bumpPermissionsVersion(tx, actor.orgId);
      return updated;
    }, { orgId: actor.orgId }).catch((error: unknown) => {
      /*
       * `uniq_roles_org_module_name_ci` — (org_id, COALESCE(module_key, ''), LOWER(name)).
       * The name check above is a read followed by a write, so this is what answers when two
       * requests pass that check together. Drizzle leaves the SQLSTATE on `.cause`; a
       * `"code" in error` test against the wrapper never fired and the race answered 500.
       */
      if (getPostgresErrorCode(error) === "23505") throw new ConflictException(`A group named "${input.name}" already exists in this module`);
      throw error;
    });
    if (!row) throw new BadRequestException("Failed to rename group");
    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    this.audit.log({ action: "module_access.group_renamed", userId: actor.userId, orgId: actor.orgId, targetId: String(groupId), targetType: "role", metadata: { moduleKey, oldName: existing.name, newName: row.name } });
    const refreshed = await this.fetchSingleGroup(actor.orgId, moduleKey, row.id);
    if (!refreshed) throw new NotFoundException("Group not found");
    return refreshed;
  }

  async deleteGroup(actor: CurrentUserContext, moduleKey: string, groupId: number): Promise<{ success: true }> {
    const existing = await this.db.query.roles.findFirst({ where: and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)) });
    if (!existing) throw new NotFoundException("Group not found");
    if (existing.isSystem) throw new ForbiddenException("System groups cannot be deleted");
    const [assignmentCountRow] = await this.db.select({ cnt: count() }).from(roleAssignments).where(and(eq(roleAssignments.orgId, actor.orgId), eq(roleAssignments.roleId, groupId)));
    if (Number(assignmentCountRow?.cnt ?? 0) > 0) throw new ConflictException("Cannot delete a group with active member assignments. Remove all members first.");
    await runInTenantTransaction(this.db, async (tx): Promise<void> => {
      await tx.delete(rolePermissionGrants).where(and(eq(rolePermissionGrants.orgId, actor.orgId), eq(rolePermissionGrants.roleId, groupId)));
      await tx.delete(roles).where(and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId)));
      await bumpPermissionsVersion(tx, actor.orgId);
    }, { orgId: actor.orgId });
    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    this.audit.log({ action: "module_access.group_deleted", userId: actor.userId, orgId: actor.orgId, targetId: String(groupId), targetType: "role", metadata: { moduleKey, name: existing.name } });
    return { success: true };
  }
}
