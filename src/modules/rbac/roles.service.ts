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
  countDistinct,
  eq,
  gte,
  ilike,
  inArray,
  like,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  groupRoleAssignments,
  organizationMembers,
  principalGroups,
  roleAssignments,
  rolePermissionGrants,
  roles,
  users,
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
import { RoleLockoutService } from "./role-lockout.service";
import {
  RolePermissionService,
  type RolePermissionMatrixEntry,
} from "./role-permission.service";
import { RoleMemberService } from "./role-member.service";
import type {
  CloneTemplateInput,
  CreateRoleInput,
  ListRolesQuery,
  RoleMemberInput,
  SetRolePermissionsInput,
  SimulationCandidatesQuery,
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
    private readonly lockout: RoleLockoutService,
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

  async listAssignableDepartments(orgId: string) {
    return this.db
      .select({
        id: principalGroups.id,
        name: principalGroups.name,
        kind: principalGroups.kind,
      })
      .from(principalGroups)
      .where(eq(principalGroups.orgId, orgId))
      .orderBy(asc(principalGroups.name));
  }

  async listSimulationCandidates(
    orgId: string,
    input: SimulationCandidatesQuery,
  ) {
    const offset = (input.page - 1) * input.limit;
    const conditions = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
    ];
    if (input.search) {
      const searchCondition = or(
        ilike(users.name, `%${input.search}%`),
        ilike(users.email, `%${input.search}%`),
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    const where = and(...conditions);
    const [data, [{ value }]] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
          designation: users.designation,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(where)
        .orderBy(asc(users.name), asc(users.email))
        .limit(input.limit)
        .offset(offset),
      this.db
        .select({ value: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(where),
    ]);
    const total = Number(value);
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

  async getSimulationTarget(orgId: string, targetUserId: string) {
    const target = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, targetUserId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { isOwner: true },
    });
    if (!target) throw new NotFoundException("Organization member not found");
    return target;
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

  async createRole(actor: CurrentUserContext, input: CreateRoleInput) {
    assertKnownPermissionKeys(input.permissions, CATALOG_KEYS);
    const targetRank = input.rank ?? ROLE_RANK.FUNCTIONAL;
    const targetModuleKey = input.moduleKey ?? null;
    const target: RoleGrantTarget = {
      rank: targetRank,
      moduleKey: targetModuleKey,
    };
    await this.assertGrantable(actor, input.permissions, target);

    const created = await runInTenantTransaction(
      this.db,
      async (tx) => {
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
            moduleKey: targetModuleKey,
            rank: targetRank,
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
      },
      { orgId: actor.orgId },
    );

    return created;
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
    const willLockOut = await this.lockout.wouldLockOutLastAdmin(
      actor.orgId,
      undefined,
      roleId,
    );
    if (willLockOut) {
      throw new ForbiddenException(
        "Cannot delete a role that would remove all role-management access",
      );
    }

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

  async getRoleAnalytics(orgId: string): Promise<{
    totalRoles: number;
    customRoles: number;
    systemRoles: number;
    totalPermissions: number;
    usersAssigned: number;
    recentChanges: number;
  }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [roleTotalsRows, assignedRows, changesRows] = await Promise.all([
      this.db
        .select({
          totalRoles: count(),
          systemRoles: sql<number>`count(*) filter (where ${roles.isSystem})`,
          customRoles: sql<number>`count(*) filter (where not ${roles.isSystem})`,
        })
        .from(roles)
        .where(eq(roles.orgId, orgId)),
      this.db
        .select({
          value: countDistinct(roleAssignments.organizationMembershipId),
        })
        .from(roleAssignments)
        .where(eq(roleAssignments.orgId, orgId)),
      this.db
        .select({ value: count() })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.orgId, orgId),
            like(auditLogs.action, "role.%"),
            gte(auditLogs.createdAt, sevenDaysAgo),
          ),
        ),
    ]);
    const roleTotals = roleTotalsRows[0];
    const assignedRow = assignedRows[0];
    const changesRow = changesRows[0];

    return {
      totalRoles: Number(roleTotals?.totalRoles ?? 0),
      customRoles: Number(roleTotals?.customRoles ?? 0),
      systemRoles: Number(roleTotals?.systemRoles ?? 0),
      totalPermissions: PERMISSIONS.length,
      usersAssigned: Number(assignedRow?.value ?? 0),
      recentChanges: Number(changesRow?.value ?? 0),
    };
  }

  async seedDefaultRoles(orgId: string) {
    await seedSystemRolesForOrg(this.db, orgId);

    const privilegedActor: CurrentUserContext = {
      userId: "",
      orgId,
      role: "ORG_ADMIN",
      permissions: [],
      isOrgOwner: true,
      tokenScopes: null,
      sessionId: "",
    };

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
      await this.cloneTemplate(privilegedActor, { templateId });
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

    const cloneTarget: RoleGrantTarget = {
      rank: ROLE_RANK.FUNCTIONAL,
      moduleKey: null,
    };
    await this.assertGrantable(actor, validPermissions, cloneTarget);

    const created = await runInTenantTransaction(
      this.db,
      async (tx) => {
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
            rank: ROLE_RANK.FUNCTIONAL,
            moduleKey: null,
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
      },
      { orgId: actor.orgId },
    );

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
