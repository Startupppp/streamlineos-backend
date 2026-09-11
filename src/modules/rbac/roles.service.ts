import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  sql,
} from "drizzle-orm";
import {
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { ROLE_TEMPLATES, type RoleTemplate } from "./role-templates.constants";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "./permissions";
import {
  deleteRole,
  updateRole,
  type RoleMutationDeps,
} from "./lib/role-mutation";
import {
  materializeTemplate,
  seedDefaultRoles,
  type RoleTemplateSeedingDeps,
} from "./lib/role-template-seeding";
import {
  RolePermissionService,
  type RolePermissionMatrixEntry,
} from "./role-permission.service";
import { RoleMemberService } from "./role-member.service";
import type {
  ListRolesQuery,
  RoleMemberInput,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from "./dto/rbac.schemas";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly rolePermission: RolePermissionService,
    private readonly roleMember: RoleMemberService,
  ) {}

  private get mutationDeps(): RoleMutationDeps {
    return { db: this.db, audit: this.audit, access: this.access };
  }

  private get seedingDeps(): RoleTemplateSeedingDeps {
    return { db: this.db };
  }

  updateRole(
    actor: CurrentUserContext,
    roleId: number,
    input: UpdateRoleInput,
  ): Promise<{ success: true }> {
    return updateRole(this.mutationDeps, actor, roleId, input);
  }

  deleteRole(
    actor: CurrentUserContext,
    roleId: number,
  ): Promise<{ success: true }> {
    return deleteRole(this.mutationDeps, actor, roleId);
  }

  seedDefaultRoles(orgId: string) {
    return seedDefaultRoles(this.seedingDeps, orgId);
  }

  /**
   * Materialises a FIXED catalog template. The caller names a template id and
   * nothing else — name, slug and permissions come from the template — so this
   * is not custom-role creation, which is why it survives while `createRole` did not.
   */
  materializeTemplate(
    actor: CurrentUserContext,
    templateId: string,
  ): Promise<typeof roles.$inferSelect> {
    return materializeTemplate(this.seedingDeps, actor, templateId);
  }

  async getRoles(orgId: string, input: ListRolesQuery) {
    const offset = (input.page - 1) * input.limit;
    const search = input.search?.trim();
    const where = search
      ? and(
          eq(roles.orgId, orgId),
          ilike(roles.name, `%${escapeLike(search)}%`),
        )
      : eq(roles.orgId, orgId);

    const [pageRows, totalRows] = await Promise.all([
      this.db
        .select({
          id: roles.id,
          name: roles.name,
          slug: roles.slug,
          rank: roles.rank,
          orgId: roles.orgId,
          version: roles.version,
          isSystem: roles.isSystem,
          moduleKey: roles.moduleKey,
          createdBy: roles.createdBy,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
          description: roles.description,
          explicitPermissionCount: count(rolePermissionGrants.id),
          universalGrantCount: sql<number>`count(${rolePermissionGrants.id}) filter (where ${inArray(rolePermissionGrants.permissionKey, [...UNIVERSAL_MEMBER_PERMISSIONS])})`,
          memberCount: sql<number>`(
            select count(distinct ${roleAssignments.organizationMembershipId})
            from ${roleAssignments}
            where ${roleAssignments.orgId} = ${orgId}
              and ${roleAssignments.roleId} = ${roles.id}
          )`,
        })
        .from(roles)
        .leftJoin(
          rolePermissionGrants,
          and(
            eq(rolePermissionGrants.orgId, orgId),
            eq(rolePermissionGrants.roleId, roles.id),
          ),
        )
        .where(where)
        .groupBy(roles.id)
        .orderBy(asc(sql`lower(${roles.name})`), asc(roles.id))
        .limit(input.limit)
        .offset(offset),
      this.db.select({ value: count() }).from(roles).where(where),
    ]);
    const total = Number(totalRows[0]?.value ?? 0);
    const data = pageRows.map(
      ({ explicitPermissionCount, universalGrantCount, memberCount, ...role }) => {
        const explicitCount = Number(explicitPermissionCount);
        const permissionCount =
          explicitCount > 0
            ? UNIVERSAL_MEMBER_PERMISSIONS.length +
              explicitCount -
              Number(universalGrantCount)
            : new Set([
                ...UNIVERSAL_MEMBER_PERMISSIONS,
                ...(ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []),
              ]).size;
        return { ...role, permissionCount, memberCount: Number(memberCount) };
      },
    );

    return {
      data,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }

  async getRole(orgId: string, roleId: number) {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
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
  ): Promise<{ success: true; version: number }> {
    return this.rolePermission.setRolePermissions(actor, roleId, input);
  }

  getPermissionsMatrix(orgId: string): Promise<RolePermissionMatrixEntry[]> {
    return this.rolePermission.getPermissionsMatrix(orgId);
  }

  listTemplates(): readonly RoleTemplate[] {
    return ROLE_TEMPLATES;
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

}
