import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { assertModuleOwnerRoleAssigned, revokeModuleOwnerRole } from "./module-owner-role.helper";
import { fetchMembershipById, resolveMembershipUserIds } from "./ownership-members.helper";
import type { SetModuleOwnerInput } from "./dto/ownership.schemas";

@Injectable()
export class OwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listModuleOwnerships(orgId: string) {
    return this.cache.cachedForOrg(
      orgId,
      "ownership:modules",
      () => this.fetchModuleOwnerships(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchModuleOwnerships(orgId: string) {
    return this.db
      .select({
        moduleKey: moduleOwnerships.moduleKey,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerUserId: organizationMembers.userId,
        ownerName: users.name,
        ownerEmail: users.email,
        createdAt: moduleOwnerships.createdAt,
        updatedAt: moduleOwnerships.updatedAt,
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
      .where(eq(moduleOwnerships.orgId, orgId))
      .orderBy(moduleOwnerships.moduleKey);
  }

  async getModuleOwnership(orgId: string, moduleKey: string) {
    return this.cache.cachedForOrg(
      orgId,
      `ownership:module:${moduleKey}`,
      () => this.fetchModuleOwnership(orgId, moduleKey),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchModuleOwnership(orgId: string, moduleKey: string) {
    const [row] = await this.db
      .select({
        moduleKey: moduleOwnerships.moduleKey,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerUserId: organizationMembers.userId,
        ownerName: users.name,
        ownerEmail: users.email,
        createdAt: moduleOwnerships.createdAt,
        updatedAt: moduleOwnerships.updatedAt,
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

    if (!row) throw new NotFoundException("Module ownership not found");
    return row;
  }

  async forceSetModuleOwner(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    input: SetModuleOwnerInput,
  ) {
    const target = await fetchMembershipById(this.db, orgId, input.ownerMembershipId);
    if (!target) throw new NotFoundException("Target membership not found in this organization");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Target membership must be ACTIVE to receive module ownership");
    }

    await this.db.transaction(async (tx) => {
      const [prevOwnership] = await tx
        .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
        .from(moduleOwnerships)
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.moduleKey, moduleKey),
          ),
        )
        .limit(1);

      await tx
        .insert(moduleOwnerships)
        .values({
          orgId,
          moduleKey,
          ownerMembershipId: input.ownerMembershipId,
        })
        .onConflictDoUpdate({
          target: [moduleOwnerships.orgId, moduleOwnerships.moduleKey],
          set: {
            ownerMembershipId: input.ownerMembershipId,
            updatedAt: new Date(),
          },
        });

      await tx
        .update(ownershipTransfers)
        .set({ status: "CANCELLED" })
        .where(
          and(
            eq(ownershipTransfers.orgId, orgId),
            eq(ownershipTransfers.moduleKey, moduleKey),
            eq(ownershipTransfers.scope, "MODULE"),
            eq(ownershipTransfers.status, "PENDING"),
          ),
        );

      if (
        prevOwnership !== undefined &&
        prevOwnership.ownerMembershipId !== input.ownerMembershipId
      ) {
        await revokeModuleOwnerRole(tx, orgId, moduleKey, prevOwnership.ownerMembershipId);
      }
      await assertModuleOwnerRoleAssigned(tx, orgId, moduleKey, input.ownerMembershipId);

      const previousOwnerMembershipId = prevOwnership?.ownerMembershipId ?? null;
      const affectedUserIds = await resolveMembershipUserIds(
        tx,
        orgId,
        previousOwnerMembershipId !== null
          ? [input.ownerMembershipId, previousOwnerMembershipId]
          : [input.ownerMembershipId],
      );

      await commitAccessChange(tx, orgId, {
        audit: {
          action: "ownership.module_owner_forced",
          userId: actorUserId,
          targetId: String(input.ownerMembershipId),
          targetType: "membership",
          metadata: { moduleKey, ownerMembershipId: input.ownerMembershipId },
        },
        revoke: {
          cache: this.cache,
          loses: [{ kind: "permissions", userIds: affectedUserIds }],
        },
        notify: {
          via: this.dispatch,
          events:
            affectedUserIds.length === 0
              ? []
              : [
                  {
                    eventKey: "ownership.module_owner.changed",
                    orgId,
                    actorUserId,
                    targetUserIds: affectedUserIds,
                    entityType: "module_ownership",
                    entityId: moduleKey,
                    title: "Module ownership changed",
                    message: `Lifecycle ownership of the ${moduleKey} module was reassigned. Your permissions for that module may have changed.`,
                    link: "/settings/organization",
                  },
                ],
        },
        afterCommit: async () => {
          await Promise.all([
            this.cache.invalidateForOrg(orgId, "ownership:modules"),
            this.cache.invalidateForOrg(orgId, `ownership:module:${moduleKey}`),
            this.cache.invalidateForOrg(orgId, `module-access:ownership:${moduleKey}`),
            this.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers"),
          ]);
        },
      });
    });

    return { success: true as const };
  }

}
