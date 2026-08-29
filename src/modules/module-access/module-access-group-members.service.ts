import {
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  organizationMembers,
  roleAssignments,
  users,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AddModuleGroupMemberInput } from "./dto/module-access.schemas";
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";

export interface ModuleGroupMember {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export class ModuleAccessGroupMembersService {
  constructor(
    private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly groupPolicy: ModuleAccessGroupPolicyService,
  ) {}

  async fetchGroupMembers(
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

    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.name ?? row.email ?? row.userId,
      email: row.email ?? "",
      avatarUrl: row.image,
    }));
  }

  async addGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: AddModuleGroupMemberInput,
  ): Promise<{ success: true }> {
    if (!actor.isOrgOwner && input.userId === actor.userId) {
      throw new ForbiddenException("You cannot add yourself to a module group");
    }

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(actor.orgId, moduleKey);
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
    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(actor.orgId, moduleKey);
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
}
