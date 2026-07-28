import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, like } from "drizzle-orm";
import {
  auditLogs,
  departments,
  groupRoles,
  organizationMembers,
  rolePermissionGrants,
  roles,
  userRoles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import {
  assertKnownPermissionKeys,
  assertPermissionsGrantable,
  toGrantableSet,
} from "../../common/rbac/grantability";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { ROLE_TEMPLATES, type RoleTemplate } from "./role-templates.constants";
import { PERMISSIONS } from "./permissions";
import { RoleLockoutService } from "./role-lockout.service";
import { RolePermissionService } from "./role-permission.service";
import { RoleMemberService } from "./role-member.service";
import type {
  CloneTemplateInput,
  CreateRoleInput,
  RoleMemberInput,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from "./dto/rbac.schemas";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));
const ROLES_PAGE_LIMIT = 100;

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly lockout: RoleLockoutService,
    private readonly rolePermission: RolePermissionService,
    private readonly roleMember: RoleMemberService,
  ) {}

  private async assertGrantable(
    actor: CurrentUserContext,
    requestedKeys: readonly string[],
  ): Promise<void> {
    if (actor.isOrgOwner || actor.isPlatformAdmin) return;
    const resolved = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    assertPermissionsGrantable(
      { isOrgOwner: false, isPlatformAdmin: false, grantable: toGrantableSet(resolved) },
      requestedKeys,
    );
  }

  async listAssignableDepartments(orgId: string) {
    return this.db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.orgId, orgId))
      .orderBy(asc(departments.name));
  }

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
    assertKnownPermissionKeys(input.permissions, CATALOG_KEYS);
    await this.assertGrantable(actor, input.permissions);

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
        })
        .returning();

      if (input.permissions.length > 0) {
        await tx.insert(rolePermissionGrants).values(
          input.permissions.map((permissionKey) => ({
            orgId: actor.orgId,
            roleId: row.id,
            permissionKey,
            scope: "all" as const,
          })),
        );
      }

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
    if (input.permissions !== undefined) {
      assertKnownPermissionKeys(input.permissions, CATALOG_KEYS);
      await this.assertGrantable(actor, input.permissions);
    }

    await this.db.transaction(async (tx): Promise<void> => {
      const existing = await tx.query.roles.findFirst({
        where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
      });
      if (!existing) throw new NotFoundException("Role not found");

      const updateData: {
        updatedAt: Date;
        name?: string;
      } = {
        updatedAt: new Date(),
      };
      if (input.name && !existing.isSystem) updateData.name = input.name;

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
    const willLockOut = await this.lockout.wouldLockOutLastAdmin(actor.orgId, undefined, roleId);
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

  getRolePermissions(
    orgId: string,
    roleId: number,
  ): Promise<{ permissionKey: string; scope: DataScope }[]> {
    return this.rolePermission.getRolePermissions(orgId, roleId);
  }

  setRolePermissions(
    actor: CurrentUserContext,
    roleId: number,
    input: SetRolePermissionsInput,
  ): Promise<{ success: true }> {
    return this.rolePermission.setRolePermissions(actor, roleId, input);
  }

  getPermissionsMatrix(orgId: string): Promise<
    {
      roleId: number;
      roleName: string;
      roleSlug: string;
      permissions: string[];
    }[]
  > {
    return this.rolePermission.getPermissionsMatrix(orgId);
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

  async seedDefaultRoles(actor: CurrentUserContext) {
    const starterTemplateIds = [
      "engineering",
      "sales_rep",
      "customer_support",
      "digital_marketing",
      "hr_admin",
      "accountant",
    ];

    const created: string[] = [];
    const skipped: string[] = [];
    for (const templateId of starterTemplateIds) {
      const template = ROLE_TEMPLATES.find((t) => t.id === templateId);
      if (!template) continue;
      const existing = await this.db.query.roles.findFirst({
        where: and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)),
        columns: { id: true },
      });
      if (existing) {
        skipped.push(template.slug);
        continue;
      }
      await this.cloneTemplate(actor, { templateId });
      created.push(template.slug);
    }
    return { created, skipped };
  }

  async cloneTemplate(actor: CurrentUserContext, input: CloneTemplateInput) {
    const template = ROLE_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) throw new NotFoundException("Template not found");

    const slug = input.slug ?? template.slug;
    const name = input.name ?? template.name;

    const validPermissions = template.permissions.filter((key) =>
      CATALOG_KEYS.has(key),
    );

    await this.assertGrantable(actor, validPermissions);

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
        })
        .returning();

      if (validPermissions.length > 0) {
        await tx.insert(rolePermissionGrants).values(
          validPermissions.map((permissionKey) => ({
            orgId: actor.orgId,
            roleId: row.id,
            permissionKey,
            scope: "all" as const,
          })),
        );
      }

      await bumpPermissionsVersion(tx, actor.orgId);
      return row;
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return created;
  }

  getRoleMembers(orgId: string, roleId: number) {
    return this.roleMember.getRoleMembers(orgId, roleId);
  }

  addRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    return this.roleMember.addRoleMember(actor, roleId, input);
  }

  removeRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    return this.roleMember.removeRoleMember(actor, roleId, input);
  }

  wouldLockOutLastAdmin(
    orgId: string,
    excludeUserId?: string,
    excludeRoleId?: number,
    excludePermissionKey?: string,
  ): Promise<boolean> {
    return this.lockout.wouldLockOutLastAdmin(
      orgId,
      excludeUserId,
      excludeRoleId,
      excludePermissionKey,
    );
  }
}
