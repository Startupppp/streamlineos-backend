import {
  BadRequestException,
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
  ilike,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  userModuleAccess,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertPermissionsGrantable,
  ROLE_RANK,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import {
  moduleAccessDenied,
  moduleOwnershipDenied,
} from "./module-access-errors";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  assertModuleEnabled,
  moduleAccessPolicyDeps,
  resolveActorRankContext,
  resolveModuleOwnerUserId,
} from "./module-access.helpers";
import { canTransferModuleOwnership } from "./module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions";
import type {
  AddFlatMemberInput,
  AddModuleGroupMemberInput,
  CreateModuleGroupInput,
  InitiateOwnershipTransferInput,
  ListMembersQuery,
  MemberCandidatesQuery,
  RenameModuleGroupInput,
  UpdateMemberGroupsInput,
} from "./dto/module-access.schemas";


export interface ModuleRoleGroup {
  id: number;
  name: string;
  isSystem: boolean;
  version: number;
  memberCount: number;
  permissions: { permissionKey: string; scope: DataScope }[];
}

export interface ModuleGroupMember {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface ModuleMemberCandidate {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface ModuleOwnership {
  moduleKey: string;
  ownerId: string;
  ownerDisplayName: string;
  ownerEmail: string;
  pendingTransfer: {
    transferId: string;
    toUserId: string;
    toDisplayName: string;
    toEmail: string;
    initiatedAt: string;
  } | null;
}

export interface FlatModuleMember {
  membershipId: number;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  groups: { id: number; name: string }[];
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

@Injectable()
export class ModuleAccessGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  private async assertAccess(
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

  /**
   * Org Owner is the documented break-glass exception to actual Module Owner
   * authority. Org Admin and Module Admin do not inherit ownership lifecycle.
   */
  private async assertOwnershipRights(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleEnabled(
      moduleAccessPolicyDeps(this.db, this.access),
      actor.orgId,
      moduleKey,
    );
    if (await canTransferModuleOwnership(this.db, actor, moduleKey)) return;
    throw moduleOwnershipDenied();
  }

  private modulePermissionKeys(moduleKey: string): Set<string> {
    return new Set(
      PERMISSIONS.filter((p) => administeringModuleOf(p.name) === moduleKey).map(
        (p) => p.name,
      ),
    );
  }

  private async assertGroupBelongsToModule(
    orgId: string,
    moduleKey: string,
    groupId: number,
  ): Promise<void> {
    const role = await this.db.query.roles.findFirst({
      where: and(
        eq(roles.id, groupId),
        eq(roles.orgId, orgId),
        eq(roles.moduleKey, moduleKey),
      ),
      columns: { id: true },
    });
    if (!role) throw new NotFoundException("Group not found");
  }

  private async resolveModuleOwnerUserId(
    orgId: string,
    moduleKey: string,
  ): Promise<string | null> {
    return resolveModuleOwnerUserId(this.db, orgId, moduleKey);
  }

  async listGroups(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleRoleGroup[]> {
    await this.assertAccess(actor, moduleKey, "view");
    const version = await this.access.getPermissionsVersion(actor.orgId);
    return this.cache.cached(
      CACHE_KEYS.moduleGroupsList(actor.orgId, moduleKey, version),
      () => this.fetchGroups(actor.orgId, moduleKey),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchGroups(
    orgId: string,
    moduleKey: string,
  ): Promise<ModuleRoleGroup[]> {
    const catalog = this.modulePermissionKeys(moduleKey);

    const orgRoles = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        isSystem: roles.isSystem,
        version: roles.version,
      })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)))
      .orderBy(asc(roles.name))
      .limit(100);

    if (orgRoles.length === 0) return [];

    const roleIds = orgRoles.map((r) => r.id);

    const [memberCountRows, grantRows, rolesWithGrantRows] = await Promise.all([
      this.db
        .select({ roleId: roleAssignments.roleId, cnt: count() })
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            inArray(roleAssignments.roleId, roleIds),
          ),
        )
        .groupBy(roleAssignments.roleId),
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

    const memberCountById = new Map<number, number>(
      memberCountRows.map((r) => [r.roleId, Number(r.cnt)]),
    );

    const moduleGrantsByRole = new Map<
      number,
      { permissionKey: string; scope: DataScope }[]
    >();
    const rolesWithAnyGrant = new Set<number>(
      rolesWithGrantRows.map((grant) => grant.roleId),
    );

    for (const grant of grantRows) {
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
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        version: role.version,
        memberCount: memberCountById.get(role.id) ?? 0,
        permissions: permissions ?? [],
      };
    });
  }

  async createGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    input: CreateModuleGroupInput,
  ): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");

    if (!actor.isOrgOwner) {
      const [resolved, isOrgAdmin] = await Promise.all([
        this.access.resolveUserPermissions(actor.orgId, actor.userId),
        isStructuralOrgAdmin(this.db, actor),
      ]);
      if (!isOrgAdmin) {
        const { bestRank, allowedModules } = await resolveActorRankContext(
          this.db,
          actor.orgId,
          actor.userId,
        );
        assertPermissionsGrantable(
          {
            isOrgOwner: false,
            grantable: toGrantableSet(resolved),
            bestRank,
            allowedModules,
          },
          [],
          { rank: ROLE_RANK.MODULE_CUSTOM, moduleKey },
        );
      }
    }

    const [existingWithName] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.orgId, actor.orgId),
          eq(roles.moduleKey, moduleKey),
          ilike(roles.name, input.name),
        ),
      )
      .limit(1);
    if (existingWithName) {
      throw new ConflictException(
        `A group named "${input.name}" already exists in this module`,
      );
    }

    const slug = `${moduleKey.toUpperCase()}_${input.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${Date.now()}`;

    const row = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [created] = await tx
          .insert(roles)
          .values({
            name: input.name,
            slug,
            orgId: actor.orgId,
            isSystem: false,
            moduleKey,
            rank: ROLE_RANK.MODULE_CUSTOM,
          })
          .returning({
            id: roles.id,
            name: roles.name,
            isSystem: roles.isSystem,
            version: roles.version,
          });
        if (!created) throw new BadRequestException("Failed to create group");
        await bumpPermissionsVersion(tx, actor.orgId);
        return created;
      },
      { orgId: actor.orgId },
    ).catch((err: unknown) => {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "23505"
      ) {
        throw new ConflictException(
          `A group named "${input.name}" already exists in this module`,
        );
      }
      throw err;
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    this.audit.log({
      action: "module_access.group_created",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(row.id),
      targetType: "role",
      metadata: { moduleKey, name: row.name },
    });
    return {
      id: row.id,
      name: row.name,
      isSystem: row.isSystem,
      version: row.version,
      memberCount: 0,
      permissions: [],
    };
  }

  async renameGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: RenameModuleGroupInput,
  ): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");

    const existing = await this.db.query.roles.findFirst({
      where: and(
        eq(roles.id, groupId),
        eq(roles.orgId, actor.orgId),
        eq(roles.moduleKey, moduleKey),
      ),
    });
    if (!existing) throw new NotFoundException("Group not found");
    if (existing.isSystem)
      throw new ForbiddenException("System groups cannot be renamed");

    const [nameConflict] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.orgId, actor.orgId),
          eq(roles.moduleKey, moduleKey),
          ilike(roles.name, input.name),
          ne(roles.id, groupId),
        ),
      )
      .limit(1);
    if (nameConflict) {
      throw new ConflictException(
        `A group named "${input.name}" already exists in this module`,
      );
    }

    const [row] = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(roles)
          .set({ name: input.name, updatedAt: new Date() })
          .where(
            and(
              eq(roles.id, groupId),
              eq(roles.orgId, actor.orgId),
              eq(roles.moduleKey, moduleKey),
            ),
          )
          .returning({
            id: roles.id,
            name: roles.name,
            isSystem: roles.isSystem,
            version: roles.version,
          });
        await bumpPermissionsVersion(tx, actor.orgId);
        return updated;
      },
      { orgId: actor.orgId },
    ).catch((err: unknown) => {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "23505"
      ) {
        throw new ConflictException(
          `A group named "${input.name}" already exists in this module`,
        );
      }
      throw err;
    });

    if (!row) throw new BadRequestException("Failed to rename group");

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    this.audit.log({
      action: "module_access.group_renamed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(groupId),
      targetType: "role",
      metadata: { moduleKey, oldName: existing.name, newName: row.name },
    });
    const refreshed = (await this.fetchGroups(actor.orgId, moduleKey)).find(
      (group) => group.id === row.id,
    );
    if (!refreshed) throw new NotFoundException("Group not found");
    return refreshed;
  }

  async deleteGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    const existing = await this.db.query.roles.findFirst({
      where: and(
        eq(roles.id, groupId),
        eq(roles.orgId, actor.orgId),
        eq(roles.moduleKey, moduleKey),
      ),
    });
    if (!existing) throw new NotFoundException("Group not found");
    if (existing.isSystem)
      throw new ForbiddenException("System groups cannot be deleted");

    const [assignmentCountRow] = await this.db
      .select({ cnt: count() })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.orgId, actor.orgId),
          eq(roleAssignments.roleId, groupId),
        ),
      );

    if (Number(assignmentCountRow?.cnt ?? 0) > 0) {
      throw new ConflictException(
        "Cannot delete a group with active member assignments. Remove all members first.",
      );
    }

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .delete(rolePermissionGrants)
          .where(
            and(
              eq(rolePermissionGrants.orgId, actor.orgId),
              eq(rolePermissionGrants.roleId, groupId),
            ),
          );
        await tx
          .delete(roles)
          .where(and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId)));
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    this.audit.log({
      action: "module_access.group_deleted",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(groupId),
      targetType: "role",
      metadata: { moduleKey, name: existing.name },
    });
    return { success: true };
  }

  async listGroupMembers(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
  ): Promise<ModuleGroupMember[]> {
    await this.assertAccess(actor, moduleKey, "view");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);
    const version = await this.access.getPermissionsVersion(actor.orgId);
    return this.cache.cached(
      CACHE_KEYS.moduleGroupMembers(actor.orgId, moduleKey, groupId, version),
      () => this.fetchGroupMembers(actor.orgId, groupId),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchGroupMembers(
    orgId: string,
    groupId: number,
  ): Promise<ModuleGroupMember[]> {
    const rows = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(roleAssignments.roleId, groupId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(100);

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.name ?? r.email ?? r.userId,
      email: r.email ?? "",
      avatarUrl: r.image,
    }));
  }

  async addGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: AddModuleGroupMemberInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    if (!actor.isOrgOwner && input.userId === actor.userId) {
      throw new ForbiddenException("You cannot add yourself to a module group");
    }

    const ownerUserId = await this.resolveModuleOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    if (ownerUserId !== null && input.userId === ownerUserId) {
      if (!actor.isOrgOwner && actor.userId !== ownerUserId) {
        throw new ForbiddenException(
          "Only the module owner, an org owner, or a platform admin may modify the module owner's group memberships",
        );
      }
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, input.userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true, status: true },
    });
    if (!member || member.status !== "ACTIVE") {
      throw new BadRequestException(
        "User must be an active member of this organization",
      );
    }

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .insert(roleAssignments)
          .values({
            orgId: actor.orgId,
            organizationMembershipId: member.id,
            roleId: groupId,
            assignedByMembershipId: null,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await this.cache.invalidate(CACHE_KEYS.userSession(input.userId));
    this.audit.log({
      action: "module_access.group_member_added",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(groupId),
      targetType: "role",
      metadata: { moduleKey, targetUserId: input.userId },
    });
    return { success: true };
  }

  async removeGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    userId: string,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    const ownerUserId = await this.resolveModuleOwnerUserId(
      actor.orgId,
      moduleKey,
    );

    if (ownerUserId !== null && userId === ownerUserId) {
      if (!actor.isOrgOwner && actor.userId !== ownerUserId) {
        throw new ForbiddenException(
          "Only the module owner, an org owner, or a platform admin may modify the module owner's group memberships",
        );
      }
    }

    if (!actor.isOrgOwner && userId === actor.userId && actor.userId !== ownerUserId) {
      throw new ForbiddenException(
        "You cannot remove yourself from a module group",
      );
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });

    if (member) {
      await runInTenantTransaction(
        this.db,
        async (tx): Promise<void> => {
          await tx
            .delete(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, actor.orgId),
                eq(roleAssignments.roleId, groupId),
                eq(roleAssignments.organizationMembershipId, member.id),
              ),
            );
          await bumpPermissionsVersion(tx, actor.orgId);
        },
        { orgId: actor.orgId },
      );
      await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
      await this.cache.invalidate(CACHE_KEYS.userSession(userId));
      this.audit.log({
        action: "module_access.group_member_removed",
        userId: actor.userId,
        orgId: actor.orgId,
        targetId: String(groupId),
        targetType: "role",
        metadata: { moduleKey, targetUserId: userId },
      });
    }

    return { success: true };
  }

  async listMemberCandidates(
    actor: CurrentUserContext,
    moduleKey: string,
    {
      page,
      pageSize,
      search,
      userId,
      excludeAssigned,
    }: MemberCandidatesQuery = {
      page: 1,
      pageSize: 20,
      search: "",
      excludeAssigned: true,
    },
  ): Promise<{ data: ModuleMemberCandidate[]; pagination: Pagination }> {
    await this.assertAccess(actor, moduleKey, "manage");
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;
    const searchPattern = `%${search}%`;
    const assignedToModule = this.db
      .select({ value: sql<number>`1` })
      .from(roleAssignments)
      .innerJoin(
        roles,
        and(
          eq(roles.orgId, roleAssignments.orgId),
          eq(roles.id, roleAssignments.roleId),
          eq(roles.moduleKey, moduleKey),
        ),
      )
      .where(
        and(
          eq(roleAssignments.orgId, actor.orgId),
          eq(roleAssignments.organizationMembershipId, organizationMembers.id),
        ),
      );
    const where = and(
      eq(organizationMembers.orgId, actor.orgId),
      eq(organizationMembers.status, "ACTIVE"),
      isNull(userModuleAccess.id),
      excludeAssigned ? notExists(assignedToModule) : undefined,
      userId ? eq(organizationMembers.userId, userId) : undefined,
      search
        ? or(
            ilike(users.name, searchPattern),
            ilike(users.email, searchPattern),
          )
        : undefined,
    );
    const baseJoin = and(
      eq(userModuleAccess.orgId, organizationMembers.orgId),
      eq(userModuleAccess.userId, organizationMembers.userId),
      eq(userModuleAccess.moduleKey, moduleKey),
      eq(userModuleAccess.enabled, false),
    );
    const [totalRows, rows] = await Promise.all([
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(userModuleAccess, baseJoin)
        .where(where),
      this.db
        .select({
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
          image: users.image,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(userModuleAccess, baseJoin)
        .where(where)
        .orderBy(asc(users.name), asc(users.email))
        .limit(limit)
        .offset(offset),
    ]);
    const total = Number(totalRows[0]?.total ?? 0);
    return {
      data: rows.map((row) => ({
        userId: row.userId,
        displayName: row.name ?? row.email ?? row.userId,
        email: row.email ?? "",
        avatarUrl: row.image,
      })),
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
    };
  }

  async getOwnership(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleOwnership> {
    await this.assertOwnershipRights(actor, moduleKey);
    return this.cache.cached(
      CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
      () => this.fetchOwnership(actor.orgId, moduleKey),
      60,
    );
  }

  private async fetchOwnership(
    orgId: string,
    moduleKey: string,
  ): Promise<ModuleOwnership> {
    const [ownerRow] = await this.db
      .select({
        ownerUserId: organizationMembers.userId,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(moduleOwnerships)
      .innerJoin(
        organizationMembers,
        and(
          eq(moduleOwnerships.orgId, organizationMembers.orgId),
          eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(moduleOwnerships.orgId, orgId),
          eq(moduleOwnerships.moduleKey, moduleKey),
        ),
      )
      .limit(1);

    if (!ownerRow)
      throw new NotFoundException("Module ownership not configured");

    const [pendingRow] = await this.db
      .select({
        id: ownershipTransfers.id,
        toMembershipId: ownershipTransfers.toMembershipId,
        initiatedAt: ownershipTransfers.initiatedAt,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.moduleKey, moduleKey),
          eq(ownershipTransfers.scope, "MODULE"),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .limit(1);

    let pendingTransfer: ModuleOwnership["pendingTransfer"] = null;

    if (pendingRow) {
      const [toMember] = await this.db
        .select({
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, pendingRow.toMembershipId),
          ),
        )
        .limit(1);

      if (toMember) {
        pendingTransfer = {
          transferId: pendingRow.id,
          toUserId: toMember.userId,
          toDisplayName: toMember.name ?? toMember.email ?? toMember.userId,
          toEmail: toMember.email ?? "",
          initiatedAt: pendingRow.initiatedAt.toISOString(),
        };
      }
    }

    return {
      moduleKey,
      ownerId: ownerRow.ownerUserId,
      ownerDisplayName:
        ownerRow.ownerName ?? ownerRow.ownerEmail ?? ownerRow.ownerUserId,
      ownerEmail: ownerRow.ownerEmail ?? "",
      pendingTransfer,
    };
  }

  async initiateOwnershipTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
    input: InitiateOwnershipTransferInput,
  ): Promise<{ success: true }> {
    await this.assertOwnershipRights(actor, moduleKey);

    const [actorMembership, toMembership] = await Promise.all([
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, actor.userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
        columns: { id: true },
      }),
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, input.toUserId),
        ),
        columns: { id: true, status: true },
      }),
    ]);

    if (!actorMembership)
      throw new ForbiddenException("Not a member of this organization");
    if (!toMembership)
      throw new NotFoundException(
        "Target user is not a member of this organization",
      );
    if (toMembership.status !== "ACTIVE")
      throw new BadRequestException("Target membership must be ACTIVE");
    if (actorMembership.id === toMembership.id)
      throw new BadRequestException("Cannot transfer ownership to yourself");

    try {
      const expiresAt = new Date(Date.now() + 48 * 3_600_000);
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx.insert(ownershipTransfers).values({
            orgId: actor.orgId,
            scope: "MODULE",
            moduleKey,
            fromMembershipId: actorMembership.id,
            toMembershipId: toMembership.id,
            status: "PENDING",
            expiresAt,
            reason: null,
          });
        },
        { orgId: actor.orgId },
      );
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "23505"
      ) {
        throw new ConflictException(
          `A pending transfer for module "${moduleKey}" already exists`,
        );
      }
      throw err;
    }

    await Promise.all([
      this.cache.invalidate(
        CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
      ),
      this.cache.invalidateNamespace(`ownership:transfers:${actor.orgId}`),
    ]);

    return { success: true };
  }

  async listMembers(
    actor: CurrentUserContext,
    moduleKey: string,
    { page, pageSize, userId }: ListMembersQuery,
  ): Promise<{ data: FlatModuleMember[]; pagination: Pagination }> {
    await this.assertAccess(
      actor,
      moduleKey,
      userId === undefined ? "view" : "manage",
    );
    const limit = Math.min(pageSize, 100);
    const version = await this.access.getPermissionsVersion(actor.orgId);
    return this.cache.cached(
      CACHE_KEYS.moduleAccessMembers(
        actor.orgId,
        moduleKey,
        page,
        limit,
        version,
        userId,
      ),
      () => this.fetchMembers(actor.orgId, moduleKey, page, limit, userId),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchMembers(
    orgId: string,
    moduleKey: string,
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ data: FlatModuleMember[]; pagination: Pagination }> {
    const offset = (page - 1) * limit;

    const moduleRoleRows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)));

    if (moduleRoleRows.length === 0) {
      return {
        data: [],
        pagination: { page, pageSize: limit, total: 0, totalPages: 0 },
      };
    }

    const moduleRoleIds = moduleRoleRows.map((r) => r.id);

    let membershipFilter: SQL | undefined;
    if (userId !== undefined) {
      const target = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
        columns: { id: true },
      });
      if (!target) {
        return {
          data: [],
          pagination: { page, pageSize: limit, total: 0, totalPages: 0 },
        };
      }
      membershipFilter = eq(
        roleAssignments.organizationMembershipId,
        target.id,
      );
    }

    const baseWhere = and(
      eq(roleAssignments.orgId, orgId),
      inArray(roleAssignments.roleId, moduleRoleIds),
      eq(organizationMembers.status, "ACTIVE"),
      membershipFilter,
    );

    const [totalResult, memberRows] = await Promise.all([
      this.db
        .select({
          total: countDistinct(roleAssignments.organizationMembershipId),
        })
        .from(roleAssignments)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, roleAssignments.orgId),
            eq(
              organizationMembers.id,
              roleAssignments.organizationMembershipId,
            ),
          ),
        )
        .where(baseWhere),
      this.db
        .selectDistinct({
          membershipId: roleAssignments.organizationMembershipId,
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
          image: users.image,
        })
        .from(roleAssignments)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, roleAssignments.orgId),
            eq(
              organizationMembers.id,
              roleAssignments.organizationMembershipId,
            ),
          ),
        )
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(baseWhere)
        .orderBy(asc(users.name))
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(totalResult[0]?.total ?? 0);

    if (memberRows.length === 0) {
      return {
        data: [],
        pagination: {
          page,
          pageSize: limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    const membershipIds = memberRows.map((r) => r.membershipId);

    const groupRows = await this.db
      .select({
        membershipId: roleAssignments.organizationMembershipId,
        groupId: roles.id,
        groupName: roles.name,
      })
      .from(roleAssignments)
      .innerJoin(
        roles,
        and(eq(roles.id, roleAssignments.roleId), eq(roles.orgId, orgId)),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          inArray(roleAssignments.organizationMembershipId, membershipIds),
          inArray(roleAssignments.roleId, moduleRoleIds),
        ),
      );

    const groupsByMembership = new Map<
      number,
      { id: number; name: string }[]
    >();
    for (const gr of groupRows) {
      const list = groupsByMembership.get(gr.membershipId) ?? [];
      list.push({ id: gr.groupId, name: gr.groupName });
      groupsByMembership.set(gr.membershipId, list);
    }

    const data: FlatModuleMember[] = memberRows.map((r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      displayName: r.name ?? r.email ?? r.userId,
      email: r.email ?? "",
      avatarUrl: r.image,
      groups: groupsByMembership.get(r.membershipId) ?? [],
    }));

    return {
      data,
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
    };
  }

  async addMember(
    actor: CurrentUserContext,
    moduleKey: string,
    input: AddFlatMemberInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    if (!actor.isOrgOwner && input.userId === actor.userId) {
      throw new ForbiddenException("You cannot add yourself to a module group");
    }

    const ownerUserId = await this.resolveModuleOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    if (ownerUserId !== null && input.userId === ownerUserId) {
      if (!actor.isOrgOwner && actor.userId !== ownerUserId) {
        throw new ForbiddenException(
          "Only the module owner, an org owner, or a platform admin may modify the module owner's group memberships",
        );
      }
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, input.userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true, status: true },
    });
    if (!member || member.status !== "ACTIVE") {
      throw new BadRequestException(
        "User must be an active member of this organization",
      );
    }

    const validGroups = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.orgId, actor.orgId),
          eq(roles.moduleKey, moduleKey),
          inArray(roles.id, input.groupIds),
        ),
      );

    if (validGroups.length !== input.groupIds.length) {
      throw new BadRequestException(
        "One or more group IDs do not belong to this module",
      );
    }

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .insert(roleAssignments)
          .values(
            input.groupIds.map((groupId) => ({
              orgId: actor.orgId,
              organizationMembershipId: member.id,
              roleId: groupId,
              assignedByMembershipId: null,
            })),
          )
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await this.cache.invalidate(CACHE_KEYS.userSession(input.userId));
    this.audit.log({
      action: "module_access.member_added",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: input.userId,
      targetType: "user",
      metadata: { moduleKey, groupIds: input.groupIds },
    });
    return { success: true };
  }

  async updateMemberGroups(
    actor: CurrentUserContext,
    moduleKey: string,
    userId: string,
    input: UpdateMemberGroupsInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    if (!actor.isOrgOwner && userId === actor.userId) {
      throw new ForbiddenException(
        "You cannot modify your own module group memberships",
      );
    }

    const ownerUserId = await this.resolveModuleOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    if (ownerUserId !== null && userId === ownerUserId) {
      if (!actor.isOrgOwner && actor.userId !== ownerUserId) {
        throw new ForbiddenException(
          "Only the module owner, an org owner, or a platform admin may modify the module owner's group memberships",
        );
      }
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true, status: true },
    });
    if (!member || member.status !== "ACTIVE") {
      throw new NotFoundException("Active member not found");
    }

    const allModuleRoles = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)));

    const allModuleRoleIds = allModuleRoles.map((r) => r.id);

    if (input.groupIds.length > 0) {
      const validIds = new Set(allModuleRoleIds);
      for (const id of input.groupIds) {
        if (!validIds.has(id)) {
          throw new BadRequestException(
            `Group ${id} does not belong to this module`,
          );
        }
      }
    }

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        if (allModuleRoleIds.length > 0) {
          await tx
            .delete(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, actor.orgId),
                eq(roleAssignments.organizationMembershipId, member.id),
                inArray(roleAssignments.roleId, allModuleRoleIds),
              ),
            );
        }

        if (input.groupIds.length > 0) {
          await tx
            .insert(roleAssignments)
            .values(
              input.groupIds.map((groupId) => ({
                orgId: actor.orgId,
                organizationMembershipId: member.id,
                roleId: groupId,
                assignedByMembershipId: null,
              })),
            )
            .onConflictDoNothing();
        }

        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    this.audit.log({
      action: "module_access.member_groups_updated",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: userId,
      targetType: "user",
      metadata: { moduleKey, groupIds: input.groupIds },
    });
    return { success: true };
  }

  async removeMember(
    actor: CurrentUserContext,
    moduleKey: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    const ownerUserId = await this.resolveModuleOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    if (ownerUserId !== null && userId === ownerUserId) {
      throw new ForbiddenException(
        "Cannot remove the module owner from the module. Transfer ownership first.",
      );
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });

    if (!member) return { success: true };

    const allModuleRoles = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)));

    if (allModuleRoles.length === 0) return { success: true };

    const allModuleRoleIds = allModuleRoles.map((r) => r.id);

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .delete(roleAssignments)
          .where(
            and(
              eq(roleAssignments.orgId, actor.orgId),
              eq(roleAssignments.organizationMembershipId, member.id),
              inArray(roleAssignments.roleId, allModuleRoleIds),
            ),
          );
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    this.audit.log({
      action: "module_access.member_removed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: userId,
      targetType: "user",
      metadata: { moduleKey },
    });
    return { success: true };
  }

  async cancelOwnershipTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<{ success: true }> {
    await this.assertOwnershipRights(actor, moduleKey);

    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        fromMembershipId: ownershipTransfers.fromMembershipId,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.orgId, actor.orgId),
          eq(ownershipTransfers.moduleKey, moduleKey),
          eq(ownershipTransfers.scope, "MODULE"),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .limit(1);

    if (!transfer)
      throw new NotFoundException("No pending transfer found for this module");

    if (!actor.isOrgOwner) {
      const actorMembership = await this.db.query.organizationMembers.findFirst(
        {
          where: and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(organizationMembers.userId, actor.userId),
          ),
          columns: { id: true },
        },
      );
      if (
        !actorMembership ||
        actorMembership.id !== transfer.fromMembershipId
      ) {
        throw new ForbiddenException(
          "Only the transfer initiator or an org owner may cancel this transfer",
        );
      }
    }

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(ownershipTransfers)
          .set({ status: "CANCELLED" })
          .where(
            and(
              eq(ownershipTransfers.id, transfer.id),
              eq(ownershipTransfers.orgId, actor.orgId),
            ),
          );
      },
      { orgId: actor.orgId },
    );

    await Promise.all([
      this.cache.invalidate(
        CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
      ),
      this.cache.invalidateNamespace(`ownership:transfers:${actor.orgId}`),
    ]);

    return { success: true };
  }
}
