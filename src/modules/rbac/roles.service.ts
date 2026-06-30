import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, like, ne } from "drizzle-orm";
import {
  auditLogs,
  departmentMembers,
  departments,
  groupRoles,
  organizationMembers,
  rolePermissionGrants,
  roles,
  userRoles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { ROLE_TEMPLATES, type RoleTemplate } from "./role-templates.constants";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "./permissions.constants";
import type {
  CloneTemplateInput,
  CreateRoleInput,
  RoleMemberInput,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from "./dto/rbac.schemas";

const RBAC_MANAGE_KEY = "settings:rbac:manage";
const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));
const ROLES_PAGE_LIMIT = 100;

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async getRoles(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.rolesList(orgId),
      () =>
        this.db.query.roles.findMany({
          where: eq(roles.orgId, orgId),
          orderBy: [asc(roles.name)],
          limit: ROLES_PAGE_LIMIT,
        }),
      CACHE_TTL.LONG,
    );
  }

  async getRole(orgId: string, roleId: number) {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  async createRole(actor: CurrentUserContext, input: CreateRoleInput) {
    const created = await this.db.transaction(async (tx) => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.slug, input.slug), eq(roles.orgId, actor.orgId)),
      });
      if (existing)
        throw new ConflictException("A role with this slug already exists");

      const [row] = await tx
        .insert(roles)
        .values({
          name: input.name,
          slug: input.slug,
          orgId: actor.orgId,
          isSystem: false,
          permissions: input.permissions,
        })
        .returning();

      await bumpPermissionsVersion(tx, actor.orgId);
      return row;
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return created;
  }

  async updateRole(
    actor: CurrentUserContext,
    roleId: number,
    input: UpdateRoleInput,
  ): Promise<{ success: true }> {
    await this.db.transaction(async (tx): Promise<void> => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
      });
      if (!existing) throw new NotFoundException("Role not found");

      const updateData: {
        updatedAt: Date;
        name?: string;
        permissions?: string[];
      } = {
        updatedAt: new Date(),
      };
      if (input.name && !existing.isSystem) updateData.name = input.name;
      if (input.permissions) updateData.permissions = input.permissions;

      await tx
        .update(roles)
        .set(updateData)
        .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));

      await bumpPermissionsVersion(tx, actor.orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.changed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: { name: input.name, permissionsUpdated: !!input.permissions },
    });

    return { success: true };
  }

  async deleteRole(
    actor: CurrentUserContext,
    roleId: number,
  ): Promise<{ success: true }> {
    const willLockOut = await this.wouldLockOutLastAdmin(actor.orgId, undefined, roleId);
    if (willLockOut) {
      throw new ForbiddenException(
        "Cannot delete a role that would remove all role-management access",
      );
    }

    await this.db.transaction(async (tx): Promise<void> => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
      });
      if (!existing) throw new NotFoundException("Role not found");
      if (existing.isSystem)
        throw new ForbiddenException("System roles cannot be deleted");

      const [{ value: legacyCount }] = await tx
        .select({ value: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(users.role, existing.slug),
          ),
        );

      const [{ value: directCount }] = await tx
        .select({ value: count() })
        .from(userRoles)
        .where(
          and(eq(userRoles.orgId, actor.orgId), eq(userRoles.roleId, roleId)),
        );

      const [{ value: groupCount }] = await tx
        .select({ value: count() })
        .from(groupRoles)
        .where(
          and(eq(groupRoles.orgId, actor.orgId), eq(groupRoles.roleId, roleId)),
        );

      const total =
        Number(legacyCount) + Number(directCount) + Number(groupCount);
      if (total > 0) {
        throw new ConflictException(
          `Cannot delete role — ${total} member assignment${total !== 1 ? "s are" : " is"} attached to it. Reassign them first.`,
        );
      }

      await tx
        .delete(roles)
        .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return { success: true };
  }

  async getRolePermissions(
    orgId: string,
    roleId: number,
  ): Promise<{ permissionKey: string; scope: DataScope }[]> {
    const role = await this.getRole(orgId, roleId);

    const grants = await this.db
      .select({
        permissionKey: rolePermissionGrants.permissionKey,
        scope: rolePermissionGrants.scope,
      })
      .from(rolePermissionGrants)
      .where(
        and(
          eq(rolePermissionGrants.orgId, orgId),
          eq(rolePermissionGrants.roleId, roleId),
        ),
      )
      .limit(500);
    if (grants.length > 0) return grants;

    const fallbackKeys =
      role.permissions.length > 0
        ? role.permissions
        : (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []);
    return fallbackKeys.map((permissionKey) => ({
      permissionKey,
      scope: "all",
    }));
  }

  async setRolePermissions(
    actor: CurrentUserContext,
    roleId: number,
    input: SetRolePermissionsInput,
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    const deduped = new Map<string, DataScope>();
    for (const item of input.items) {
      if (!CATALOG_KEYS.has(item.key)) {
        throw new BadRequestException(`Unknown permission key: ${item.key}`);
      }
      deduped.set(item.key, item.scope);
    }

    await this.db.transaction(async (tx): Promise<void> => {
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
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.permissions.set",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: { count: deduped.size },
    });

    return { success: true };
  }

  async getRoleMembers(orgId: string, roleId: number) {
    await this.getRole(orgId, roleId);

    const direct = await this.db
      .select({
        userId: userRoles.userId,
        name: users.name,
        email: users.email,
      })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.orgId, orgId), eq(userRoles.roleId, roleId)))
      .limit(100);

    const departmentRows = await this.db
      .select({ departmentId: groupRoles.groupId, name: departments.name })
      .from(groupRoles)
      .innerJoin(departments, eq(groupRoles.groupId, departments.id))
      .where(
        and(
          eq(groupRoles.orgId, orgId),
          eq(groupRoles.groupType, "department"),
          eq(groupRoles.roleId, roleId),
        ),
      )
      .limit(100);

    const departmentIds = departmentRows.map((row) => row.departmentId);
    const viaDepartment =
      departmentIds.length > 0
        ? await this.db
            .select({
              userId: departmentMembers.userId,
              name: users.name,
              email: users.email,
              departmentId: departmentMembers.departmentId,
            })
            .from(departmentMembers)
            .innerJoin(users, eq(departmentMembers.userId, users.id))
            .where(inArray(departmentMembers.departmentId, departmentIds))
            .limit(500)
        : [];

    const effective = new Map<
      string,
      { userId: string; name: string | null; email: string }
    >();
    for (const member of direct) effective.set(member.userId, member);
    for (const member of viaDepartment) {
      if (!effective.has(member.userId)) {
        effective.set(member.userId, {
          userId: member.userId,
          name: member.name,
          email: member.email,
        });
      }
    }

    return {
      direct,
      departments: departmentRows,
      effective: Array.from(effective.values()),
    };
  }

  async addRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    if (input.principalType === "user") {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, input.principalId),
        ),
        columns: { id: true },
      });
      if (!member)
        throw new BadRequestException(
          "User is not a member of this organization",
        );

      await this.db.transaction(async (tx): Promise<void> => {
        await tx
          .insert(userRoles)
          .values({
            orgId: actor.orgId,
            userId: input.principalId,
            roleId,
            assignedBy: actor.userId,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      });
    } else {
      const department = await this.db.query.departments.findFirst({
        where: and(
          eq(departments.id, input.principalId),
          eq(departments.orgId, actor.orgId),
        ),
        columns: { id: true },
      });
      if (!department)
        throw new BadRequestException(
          "Department not found in this organization",
        );

      await this.db.transaction(async (tx): Promise<void> => {
        await tx
          .insert(groupRoles)
          .values({
            orgId: actor.orgId,
            groupType: "department",
            groupId: input.principalId,
            roleId,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      });
    }

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.member.added",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: {
        principalType: input.principalType,
        principalId: input.principalId,
      },
    });

    return { success: true };
  }

  async removeRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    if (input.principalType === "user") {
      const willLockOut = await this.wouldLockOutLastAdmin(actor.orgId, input.principalId);
      if (willLockOut) {
        throw new ForbiddenException(
          "Cannot remove the last administrator with role-management access",
        );
      }
    }

    await this.db.transaction(async (tx): Promise<void> => {
      if (input.principalType === "user") {
        await tx
          .delete(userRoles)
          .where(
            and(
              eq(userRoles.orgId, actor.orgId),
              eq(userRoles.roleId, roleId),
              eq(userRoles.userId, input.principalId),
            ),
          );
      } else {
        await tx
          .delete(groupRoles)
          .where(
            and(
              eq(groupRoles.orgId, actor.orgId),
              eq(groupRoles.roleId, roleId),
              eq(groupRoles.groupType, "department"),
              eq(groupRoles.groupId, input.principalId),
            ),
          );
      }
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.member.removed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: {
        principalType: input.principalType,
        principalId: input.principalId,
      },
    });

    return { success: true };
  }

  async getPermissionsMatrix(orgId: string): Promise<
    {
      roleId: number;
      roleName: string;
      roleSlug: string;
      permissions: string[];
    }[]
  > {
    const orgRoles = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        permissions: roles.permissions,
      })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .orderBy(asc(roles.name))
      .limit(ROLES_PAGE_LIMIT);

    const allGrants = await this.db
      .select({
        roleId: rolePermissionGrants.roleId,
        permissionKey: rolePermissionGrants.permissionKey,
      })
      .from(rolePermissionGrants)
      .where(eq(rolePermissionGrants.orgId, orgId))
      .limit(10000);

    const grantsByRole = new Map<number, string[]>();
    for (const grant of allGrants) {
      const existing = grantsByRole.get(grant.roleId) ?? [];
      existing.push(grant.permissionKey);
      grantsByRole.set(grant.roleId, existing);
    }

    return orgRoles.map((role) => {
      const explicit = grantsByRole.get(role.id);
      const permissions =
        explicit ??
        (role.permissions.length > 0
          ? role.permissions
          : (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []));
      return {
        roleId: role.id,
        roleName: role.name,
        roleSlug: role.slug,
        permissions,
      };
    });
  }

  listTemplates(): readonly RoleTemplate[] {
    return ROLE_TEMPLATES;
  }

  async getRoleAnalytics(orgId: string): Promise<{
    totalRoles: number;
    customRoles: number;
    systemRoles: number;
    totalPermissions: number;
    usersAssigned: number;
    recentChanges: number;
  }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const orgRoles = await this.db
      .select({ id: roles.id, isSystem: roles.isSystem })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .limit(ROLES_PAGE_LIMIT);

    const totalRoles = orgRoles.length;
    const systemRoles = orgRoles.filter((r) => r.isSystem).length;
    const customRoles = totalRoles - systemRoles;

    const roleIds = orgRoles.map((r) => r.id);
    const [assignedRow] = roleIds.length > 0
      ? await this.db
          .select({ value: count() })
          .from(userRoles)
          .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.roleId, roleIds)))
      : [{ value: 0 }];

    const [changesRow] = await this.db
      .select({ value: count() })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, orgId),
          like(auditLogs.action, "role.%"),
          gte(auditLogs.createdAt, sevenDaysAgo),
        ),
      );

    return {
      totalRoles,
      customRoles,
      systemRoles,
      totalPermissions: PERMISSIONS.length,
      usersAssigned: Number(assignedRow.value),
      recentChanges: Number(changesRow.value),
    };
  }

  async cloneTemplate(actor: CurrentUserContext, input: CloneTemplateInput) {
    const template = ROLE_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) throw new NotFoundException("Template not found");

    const slug = input.slug ?? template.slug;
    const name = input.name ?? template.name;

    const validPermissions = template.permissions.filter((key) =>
      CATALOG_KEYS.has(key),
    );

    const created = await this.db.transaction(async (tx) => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.slug, slug), eq(roles.orgId, actor.orgId)),
      });
      if (existing)
        throw new ConflictException(
          `A role with slug "${slug}" already exists`,
        );

      const [row] = await tx
        .insert(roles)
        .values({
          name,
          slug,
          orgId: actor.orgId,
          isSystem: false,
          permissions: validPermissions,
        })
        .returning();

      await bumpPermissionsVersion(tx, actor.orgId);
      return row;
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return created;
  }

  async wouldLockOutLastAdmin(
    orgId: string,
    excludeUserId?: string,
    excludeRoleId?: number,
    excludePermissionKey?: string,
  ): Promise<boolean> {
    const ownerRows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, true)))
      .limit(1)
      .catch(() => null);
    if (ownerRows && ownerRows.length > 0) return false;

    const excludedRoleId: number | undefined =
      excludeRoleId !== undefined && excludePermissionKey === RBAC_MANAGE_KEY
        ? excludeRoleId
        : undefined;

    const rows = await this.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(
        rolePermissionGrants,
        and(
          eq(rolePermissionGrants.roleId, userRoles.roleId),
          eq(rolePermissionGrants.orgId, orgId),
          eq(rolePermissionGrants.permissionKey, RBAC_MANAGE_KEY),
          ne(rolePermissionGrants.scope, "none"),
          excludedRoleId !== undefined
            ? ne(rolePermissionGrants.roleId, excludedRoleId)
            : undefined,
        ),
      )
      .where(eq(userRoles.orgId, orgId))
      .catch(() => null);

    if (!rows) return false;

    const holderIds = new Set(rows.map((r) => r.userId));
    if (excludeUserId) holderIds.delete(excludeUserId);

    return holderIds.size === 0;
  }
}
