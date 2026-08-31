import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
  groupRoleAssignments,
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertKnownPermissionKeys,
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  isImmutableSystemRole,
  ROLE_RANK,
  toGrantableSet,
  type RoleGrantTarget,
} from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { seedSystemRolesForOrg } from "./seed-system-roles";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { ROLE_TEMPLATES, type RoleTemplate } from "./role-templates.constants";
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "./permissions";
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

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));

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


  private async assertGrantable(
    actor: CurrentUserContext,
    requestedKeys: readonly string[],
    target?: RoleGrantTarget,
  ): Promise<void> {
    if (actor.isOrgOwner) return;
    const [resolved, { bestRank, allowedModules }] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveActorRankContext(this.db, actor.orgId, actor.userId),
    ]);
    const permMeta = buildPermissionModuleMap(requestedKeys);
    assertPermissionsGrantable(
      {
        isOrgOwner: false,
        grantable: toGrantableSet(resolved),
        bestRank,
        allowedModules,
      },
      requestedKeys,
      target,
      permMeta,
    );
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

  async updateRole(
    actor: CurrentUserContext,
    roleId: number,
    input: UpdateRoleInput,
  ): Promise<{ success: true }> {
    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        const existing = await tx.query.roles.findFirst({
          where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
        });
        if (!existing) throw new NotFoundException("Role not found");

        if (
          isImmutableSystemRole(existing) &&
          (input.name !== undefined || input.permissions !== undefined)
        ) {
          throw new ForbiddenException(
            "Organization-level system roles cannot be modified",
          );
        }

        if (input.permissions !== undefined) {
          assertKnownPermissionKeys(input.permissions, CATALOG_KEYS);
          const target: RoleGrantTarget = {
            rank: existing.rank,
            moduleKey: existing.moduleKey,
          };
          await this.assertGrantable(actor, input.permissions, target);
        }

        const updateData: {
          updatedAt: Date;
          name?: string;
        } = {
          updatedAt: new Date(),
        };
        if (input.name) updateData.name = input.name;

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
      },
      { orgId: actor.orgId },
    );

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
    if (!(await isStructuralOrgAdmin(this.db, actor)))
      throw new ForbiddenException("Only org admins may delete roles");

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        const existing = await tx.query.roles.findFirst({
          where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
        });
        if (!existing) throw new NotFoundException("Role not found");
        if (existing.isSystem)
          throw new ForbiddenException("System roles cannot be deleted");

        const [{ value: directCount }] = await tx
          .select({ value: count() })
          .from(roleAssignments)
          .where(
            and(
              eq(roleAssignments.orgId, actor.orgId),
              eq(roleAssignments.roleId, roleId),
            ),
          );

        const [{ value: groupCount }] = await tx
          .select({ value: count() })
          .from(groupRoleAssignments)
          .where(
            and(
              eq(groupRoleAssignments.orgId, actor.orgId),
              eq(groupRoleAssignments.roleId, roleId),
            ),
          );

        const total = Number(directCount) + Number(groupCount);
        if (total > 0) {
          throw new ConflictException(
            `Cannot delete role — ${total} member assignment${total !== 1 ? "s are" : " is"} attached to it. Reassign them first.`,
          );
        }

        await tx
          .delete(roles)
          .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

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
  ): Promise<{ success: true; version: number }> {
    return this.rolePermission.setRolePermissions(actor, roleId, input);
  }

  getPermissionsMatrix(orgId: string): Promise<RolePermissionMatrixEntry[]> {
    return this.rolePermission.getPermissionsMatrix(orgId);
  }

  listTemplates(): readonly RoleTemplate[] {
    return ROLE_TEMPLATES;
  }

  async seedDefaultRoles(orgId: string) {
    await seedSystemRolesForOrg(this.db, orgId);

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
        where: and(eq(roles.slug, template.slug), eq(roles.orgId, orgId)),
        columns: { id: true },
      });
      if (existing) {
        skipped.push(template.slug);
        continue;
      }
      await this.seedFromTemplate(orgId, template);
      created.push(template.slug);
    }
    return { created, skipped };
  }

  /**
   * Materialises a FIXED catalog template. The caller names a template id and
   * nothing else — name, slug and permissions come from the template — so this
   * is not custom-role creation, which is why it survives while `createRole` did not.
   */
  async materializeTemplate(
    actor: CurrentUserContext,
    templateId: string,
  ): Promise<typeof roles.$inferSelect> {
    if (!(await isStructuralOrgAdmin(this.db, actor)))
      throw new ForbiddenException(
        "Only an organization owner or administrator may add a role",
      );

    const template = ROLE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new NotFoundException("Role template not found");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)),
    });
    if (existing) return existing;

    await this.seedFromTemplate(actor.orgId, template);
    const [created] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)))
      .limit(1);
    if (!created) throw new ConflictException("Role template could not be created");
    return created;
  }

  private async seedFromTemplate(orgId: string, template: RoleTemplate): Promise<void> {
    const validPermissions = template.permissions.filter((k) => CATALOG_KEYS.has(k));
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .insert(roles)
          .values({
            name: template.name,
            slug: template.slug,
            orgId,
            isSystem: false,
            rank: ROLE_RANK.FUNCTIONAL,
            moduleKey: null,
          })
          .returning();

        if (validPermissions.length > 0) {
          await tx.insert(rolePermissionGrants).values(
            validPermissions.map((permissionKey) => ({
              orgId,
              roleId: row.id,
              permissionKey,
              scope: "all" as const,
            })),
          );
        }

        await bumpPermissionsVersion(tx, orgId);
      },
      { orgId },
    );
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
