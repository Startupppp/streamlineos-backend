import {
  BadRequestException,
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
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  organizationMembers,
  ownershipTransfers,
  roleAssignments,
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
} from "../../common/rbac/grantability";
import { moduleOwnershipDenied } from "./module-access-errors";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  assertModuleEnabled,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import { canTransferModuleOwnership } from "./module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
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
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";
import {
  ModuleAccessGroupMembersService,
  type ModuleGroupMember,
} from "./module-access-group-members.service";
import {
  ModuleAccessOwnershipService,
  type ModuleOwnership,
} from "./module-access-ownership.service";
import { ModuleAccessGroupCrudService } from "./module-access-group-crud.service";
import type {
  FlatModuleMember,
  ModuleMemberCandidate,
  ModuleRoleGroup,
  Pagination,
} from "./module-access-groups.types";


export type { ModuleGroupMember } from "./module-access-group-members.service";
export type {
  FlatModuleMember,
  ModuleMemberCandidate,
  ModuleRoleGroup,
} from "./module-access-groups.types";

@Injectable()
export class ModuleAccessGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly groupPolicy: ModuleAccessGroupPolicyService,
    private readonly groupCrud: ModuleAccessGroupCrudService,
  ) {
    this.ownership = new ModuleAccessOwnershipService(this.db, this.cache);
    this.groupMembers = new ModuleAccessGroupMembersService(
      this.db,
      this.cache,
      this.audit,
      this.groupPolicy,
    );
  }

  private readonly ownership: ModuleAccessOwnershipService;
  private readonly groupMembers: ModuleAccessGroupMembersService;

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

  private async assertGroupBelongsToModule(
    orgId: string,
    moduleKey: string,
    groupId: number,
  ): Promise<void> {
    await this.groupPolicy.assertGroupBelongsToModule(orgId, moduleKey, groupId);
  }

  private async resolveModuleOwnerUserId(
    orgId: string,
    moduleKey: string,
  ): Promise<string | null> {
    return this.groupPolicy.resolveOwnerUserId(orgId, moduleKey);
  }

  async listGroups(actor: CurrentUserContext, moduleKey: string): Promise<ModuleRoleGroup[]> {
    await this.assertAccess(actor, moduleKey, "view");
    return this.groupCrud.listGroups(actor.orgId, moduleKey, await this.access.getPermissionsVersion(actor.orgId));
  }

  async createGroup(actor: CurrentUserContext, moduleKey: string, input: CreateModuleGroupInput): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");
    return this.groupCrud.createGroup(actor, moduleKey, input);
  }

  async renameGroup(actor: CurrentUserContext, moduleKey: string, groupId: number, input: RenameModuleGroupInput): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");
    return this.groupCrud.renameGroup(actor, moduleKey, groupId, input);
  }

  async deleteGroup(actor: CurrentUserContext, moduleKey: string, groupId: number): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    return this.groupCrud.deleteGroup(actor, moduleKey, groupId);
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
      () => this.groupMembers.fetchGroupMembers(actor.orgId, groupId),
      CACHE_TTL.VERY_LONG,
    );
  }

  async addGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: AddModuleGroupMemberInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    return this.groupMembers.addGroupMember(actor, moduleKey, groupId, input);
  }

  async removeGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    userId: string,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    return this.groupMembers.removeGroupMember(actor, moduleKey, groupId, userId);
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
      eq(userModuleAccess.organizationMembershipId, organizationMembers.id),
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
    return this.ownership.getOwnership(actor.orgId, moduleKey);
  }

  async initiateOwnershipTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
    input: InitiateOwnershipTransferInput,
  ): Promise<{ success: true }> {
    await this.assertOwnershipRights(actor, moduleKey);
    return this.ownership.initiateTransfer(
      actor.orgId,
      moduleKey,
      actor.userId,
      input.toUserId,
    );
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
