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
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import {
  assertFlatMemberWriteAllowed,
  assertGroupsBelongToModule,
  assertMayEditOwnerMemberships,
  findActiveMembershipId,
  invalidateMemberAccessCaches,
  listModuleRoleIds,
  type FlatMemberWriteDeps,
} from "./lib/flat-member-writes";
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
    await assertFlatMemberWriteAllowed(this.writeDeps, actor, moduleKey);

    if (!actor.isOrgOwner && input.userId === actor.userId) {
      throw new ForbiddenException("You cannot add yourself to a module group");
    }

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    assertMayEditOwnerMemberships(actor, input.userId, ownerUserId);

    const membershipId = await findActiveMembershipId(
      this.writeDeps,
      actor.orgId,
      input.userId,
    );
    if (membershipId === null) {
      throw new BadRequestException(
        "User must be an active member of this organization",
      );
    }

    await assertGroupsBelongToModule(
      this.writeDeps,
      actor.orgId,
      moduleKey,
      input.groupIds,
    );

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .insert(roleAssignments)
          .values(
            input.groupIds.map((groupId) => ({
              orgId: actor.orgId,
              organizationMembershipId: membershipId,
              roleId: groupId,
              assignedByMembershipId: null,
            })),
          )
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await invalidateMemberAccessCaches(
      this.writeDeps,
      actor.orgId,
      input.userId,
    );
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
    await assertFlatMemberWriteAllowed(this.writeDeps, actor, moduleKey);

    if (!actor.isOrgOwner && userId === actor.userId) {
      throw new ForbiddenException(
        "You cannot modify your own module group memberships",
      );
    }

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    assertMayEditOwnerMemberships(actor, userId, ownerUserId);

    const membershipId = await findActiveMembershipId(
      this.writeDeps,
      actor.orgId,
      userId,
    );
    if (membershipId === null) {
      throw new NotFoundException("Active member not found");
    }

    const allModuleRoleIds = await listModuleRoleIds(
      this.writeDeps,
      actor.orgId,
      moduleKey,
    );

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
                eq(roleAssignments.organizationMembershipId, membershipId),
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
                organizationMembershipId: membershipId,
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

    await invalidateMemberAccessCaches(this.writeDeps, actor.orgId, userId);
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
    await assertFlatMemberWriteAllowed(this.writeDeps, actor, moduleKey);

    const ownerUserId = await this.groupPolicy.resolveOwnerUserId(
      actor.orgId,
      moduleKey,
    );
    if (ownerUserId !== null && userId === ownerUserId) {
      throw new ForbiddenException(
        "Cannot remove the module owner from the module. Transfer ownership first.",
      );
    }

    // Deliberately not `findActiveMembershipId`: a member who has since been
    // suspended still has assignment rows, and removing them must still work.
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });

    if (!member) return { success: true };

    const allModuleRoleIds = await listModuleRoleIds(
      this.writeDeps,
      actor.orgId,
      moduleKey,
    );
    if (allModuleRoleIds.length === 0) return { success: true };

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

    await invalidateMemberAccessCaches(this.writeDeps, actor.orgId, userId);
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

  private get writeDeps(): FlatMemberWriteDeps {
    return { db: this.db, cache: this.cache, access: this.access };
  }
}
