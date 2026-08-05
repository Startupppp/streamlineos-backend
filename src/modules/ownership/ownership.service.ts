import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
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
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { assignModuleOwnerRole, revokeModuleOwnerRole } from "./module-owner-role.helper";
import { fetchMembershipById, resolveMembershipUserIds } from "./ownership-members.helper";
import type { SetModuleOwnerInput } from "./dto/ownership.schemas";

@Injectable()
export class OwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private readonly logger = new Logger(OwnershipService.name);

  async listModuleOwnerships(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.moduleOwnershipsList(orgId),
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
    return this.cache.cached(
      CACHE_KEYS.moduleOwnershipDetail(orgId, moduleKey),
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

    const previousOwnerMembershipId = await this.db.transaction(async (tx) => {
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
      await assignModuleOwnerRole(tx, orgId, moduleKey, input.ownerMembershipId);

      await bumpPermissionsVersion(tx, orgId);
      return prevOwnership?.ownerMembershipId ?? null;
    });

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.moduleOwnershipsList(orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleOwnershipDetail(orgId, moduleKey)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKey)),
      this.cache.invalidateNamespace(`ownership:transfers:${orgId}`),
    ]);

    this.audit.log({
      action: "ownership.module_owner_forced",
      userId: actorUserId,
      orgId,
      targetId: String(input.ownerMembershipId),
      targetType: "membership",
      metadata: { moduleKey, ownerMembershipId: input.ownerMembershipId },
    });

    await this.notifyModuleOwnerChanged(
      orgId,
      actorUserId,
      moduleKey,
      input.ownerMembershipId,
      previousOwnerMembershipId,
    ).catch((error: unknown) => {
      this.logger.warn(
        `module-owner-changed notification skipped for ${moduleKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return { success: true as const };
  }

  private async notifyModuleOwnerChanged(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    newOwnerMembershipId: number,
    previousOwnerMembershipId: number | null,
  ): Promise<void> {
    const membershipIds =
      previousOwnerMembershipId !== null && previousOwnerMembershipId !== newOwnerMembershipId
        ? [newOwnerMembershipId, previousOwnerMembershipId]
        : [newOwnerMembershipId];
    const targetUserIds = await resolveMembershipUserIds(this.db, orgId, membershipIds);
    if (targetUserIds.length === 0) return;

    void this.dispatch.emit({
      eventKey: "ownership.module_owner.changed",
      orgId,
      actorUserId,
      targetUserIds,
      entityType: "module_ownership",
      entityId: moduleKey,
      title: "Module ownership changed",
      message: `Lifecycle ownership of the ${moduleKey} module was reassigned. Your permissions for that module may have changed.`,
      link: "/settings/organization",
    });
  }
}
