import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
  roleAssignments,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  canGrantToRank,
  ROLE_RANK,
} from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import { moduleDefinition } from "../../common/rbac/module-registry";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
  resolveModuleOwnerUserId,
} from "./module-access.helpers";
import {
  assertModuleOwnerRoleAssigned,
  revokeModuleOwnerRole,
} from "../ownership/module-owner-role.helper";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { assertOwnerOnly } from "../../common/rbac/owner-only-operations";
import { AccessService } from "../access/access.service";

@Injectable()
export class ModuleStandingMutationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  private async assertManageAccess(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      "manage",
    );
  }

  async grantAdminStanding(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
  ): Promise<{ success: true }> {
    await this.assertManageAccess(actor, moduleKey);

    if (!actor.isOrgOwner) {
      const isOrgAdmin = await isStructuralOrgAdmin(this.db, actor);
      if (!isOrgAdmin) {
        const { bestRank, allowedModules } = await resolveActorRankContext(
          this.db,
          actor.orgId,
          actor.userId,
        );
        if (!canGrantToRank(bestRank, allowedModules, ROLE_RANK.MODULE_ADMIN, moduleKey)) {
          throw new ForbiddenException(
            `You cannot grant module-admin standing; your highest rank is ${bestRank}, which does not permit granting rank ${ROLE_RANK.MODULE_ADMIN}`,
          );
        }
      }
    }

    const targetMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.id, membershipId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true, userId: true },
    });
    if (!targetMembership) throw new NotFoundException("Active member not found");

    if (!actor.isOrgOwner && targetMembership.userId === actor.userId)
      throw new ForbiddenException("You cannot grant standing to yourself");

    const ownerUserId = await resolveModuleOwnerUserId(this.db, actor.orgId, moduleKey);
    if (ownerUserId !== null && targetMembership.userId === ownerUserId)
      throw new BadRequestException(
        "The module owner already holds the highest module standing; grant is not applicable",
      );

    const [adminRole] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.orgId, actor.orgId),
          eq(roles.moduleKey, moduleKey),
          eq(roles.rank, ROLE_RANK.MODULE_ADMIN),
          eq(roles.isSystem, true),
        ),
      )
      .limit(1);

    if (!adminRole)
      throw new BadRequestException(
        `No system module-admin role is seeded for "${moduleKey}"; standing cannot be granted`,
      );

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .insert(roleAssignments)
          .values({
            orgId: actor.orgId,
            organizationMembershipId: membershipId,
            roleId: adminRole.id,
            assignedByMembershipId: null,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId)),
      this.cache.invalidate(CACHE_KEYS.userSession(targetMembership.userId)),
    ]);

    this.audit.log({
      action: "module_access.standing_granted",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(membershipId),
      targetType: "membership",
      metadata: {
        moduleKey,
        rank: ROLE_RANK.MODULE_ADMIN,
        targetUserId: targetMembership.userId,
      },
    });

    return { success: true };
  }

  async revokeStanding(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
  ): Promise<{ success: true }> {
    await this.assertManageAccess(actor, moduleKey);

    const targetMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.id, membershipId),
      ),
      columns: { id: true, userId: true },
    });
    if (!targetMembership) throw new NotFoundException("Member not found");

    const ownerUserId = await resolveModuleOwnerUserId(this.db, actor.orgId, moduleKey);
    if (ownerUserId !== null && targetMembership.userId === ownerUserId)
      throw new ForbiddenException(
        "Cannot revoke the module owner's standing. Transfer ownership first.",
      );

    if (!actor.isOrgOwner && targetMembership.userId === actor.userId)
      throw new ForbiddenException("You cannot revoke your own standing");

    const allModuleRoles = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)));

    if (allModuleRoles.length > 0) {
      const allModuleRoleIds = allModuleRoles.map((r) => r.id);
      await runInTenantTransaction(
        this.db,
        async (tx): Promise<void> => {
          await tx
            .delete(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, actor.orgId),
                eq(roleAssignments.organizationMembershipId, membershipId),
                inArray(roleAssignments.roleId, allModuleRoleIds),
              ),
            );
          await bumpPermissionsVersion(tx, actor.orgId);
        },
        { orgId: actor.orgId },
      );
    }

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId)),
      this.cache.invalidate(CACHE_KEYS.userSession(targetMembership.userId)),
    ]);

    this.audit.log({
      action: "module_access.standing_revoked",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(membershipId),
      targetType: "membership",
      metadata: { moduleKey, targetUserId: targetMembership.userId },
    });

    return { success: true };
  }

  async directTransferOwnership(
    actor: CurrentUserContext,
    moduleKey: string,
    toMembershipId: number,
  ): Promise<{ success: true }> {
    assertManagedModule(moduleKey);

    const definition = moduleDefinition(moduleKey);
    if (!definition?.administrable)
      throw new ForbiddenException(
        `The ${definition?.displayName ?? moduleKey} module does not support ownership transfer`,
      );

    assertOwnerOnly(actor, "organization.ownership.direct-module-transfer");

    const actorMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, actor.userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!actorMembership)
      throw new ForbiddenException("Not an active member of this organization");

    if (actorMembership.id === toMembershipId)
      throw new BadRequestException("Cannot transfer ownership to yourself");

    const toMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.id, toMembershipId),
      ),
      columns: { id: true, userId: true, status: true },
    });
    if (!toMembership)
      throw new NotFoundException("Target membership not found in this organization");
    if (toMembership.status !== "ACTIVE")
      throw new BadRequestException("Target membership must be ACTIVE to receive module ownership");

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        const [prevOwnership] = await tx
          .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
          .from(moduleOwnerships)
          .where(
            and(
              eq(moduleOwnerships.orgId, actor.orgId),
              eq(moduleOwnerships.moduleKey, moduleKey),
            ),
          )
          .limit(1);

        await tx
          .insert(moduleOwnerships)
          .values({
            orgId: actor.orgId,
            moduleKey,
            ownerMembershipId: toMembershipId,
          })
          .onConflictDoUpdate({
            target: [moduleOwnerships.orgId, moduleOwnerships.moduleKey],
            set: {
              ownerMembershipId: toMembershipId,
              updatedAt: new Date(),
            },
          });

        await tx
          .update(ownershipTransfers)
          .set({ status: "CANCELLED" })
          .where(
            and(
              eq(ownershipTransfers.orgId, actor.orgId),
              eq(ownershipTransfers.moduleKey, moduleKey),
              eq(ownershipTransfers.scope, "MODULE"),
              eq(ownershipTransfers.status, "PENDING"),
            ),
          );

        if (
          prevOwnership !== undefined &&
          prevOwnership.ownerMembershipId !== toMembershipId
        )
          await revokeModuleOwnerRole(tx, actor.orgId, moduleKey, prevOwnership.ownerMembershipId);

        await assertModuleOwnerRoleAssigned(tx, actor.orgId, moduleKey, toMembershipId);
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleOwnershipsList(actor.orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleOwnershipDetail(actor.orgId, moduleKey)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey)),
      this.cache.invalidateNamespace(`ownership:transfers:${actor.orgId}`),
    ]);

    this.audit.log({
      action: "module_access.ownership_transferred",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(toMembershipId),
      targetType: "membership",
      metadata: { moduleKey, toMembershipId },
    });

    return { success: true };
  }
}
