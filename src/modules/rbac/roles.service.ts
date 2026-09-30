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
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetAfterValueExpression } from "../../common/pagination/keyset";


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
    return { db: this.db, access: this.access };
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

  async getRoles(orgId: string, input: ListRolesQuery) {
    const search = input.search?.trim();
    const baseWhere = search
      ? and(
          eq(roles.orgId, orgId),
          ilike(roles.name, `%${escapeLike(search)}%`),
        )
      : eq(roles.orgId, orgId);
    const normalizedName = sql<string>`lower(${roles.name})`;
    const position = decodeCursor(input.cursor);
    const where = and(
      baseWhere,
      position
        ? keysetAfterValueExpression(normalizedName, roles.name, roles.id, position)
        : undefined,
    );

    const rows = await this.db
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
          cursorSortValue: normalizedName,
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
        .orderBy(asc(normalizedName), asc(roles.id))
        .limit(input.limit + 1);
    const page = buildCursorPage(rows, input.limit, (row) => ({
      sortValue: row.cursorSortValue,
      id: String(row.id),
    }));
    const data = page.data.map(
      ({ explicitPermissionCount, universalGrantCount, memberCount, cursorSortValue: _cursor, ...role }) => {
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

    return { data, pagination: page.pagination };
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
