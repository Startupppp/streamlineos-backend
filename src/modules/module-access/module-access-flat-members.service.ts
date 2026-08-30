import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  organizationMembers,
  roleAssignments,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import type {
  AddFlatMemberInput,
  UpdateMemberGroupsInput,
} from "./dto/module-access.schemas";
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";

@Injectable()
export class ModuleAccessFlatMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly groupPolicy: ModuleAccessGroupPolicyService,
  ) {}

  async addMember(
    actor: CurrentUserContext,
    moduleKey: string,
    input: AddFlatMemberInput,
  ): Promise<{ success: true }> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      "manage",
    );

    if (!actor.isOrgOwner && input.userId === actor.userId) {
      throw new ForbiddenException("You cannot add yourself to a module group");
    }

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(
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
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      "manage",
    );

    if (!actor.isOrgOwner && userId === actor.userId) {
      throw new ForbiddenException(
        "You cannot modify your own module group memberships",
      );
    }

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(
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
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      "manage",
    );

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(
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
}
