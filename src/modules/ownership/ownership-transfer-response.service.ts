import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  organizations,
  ownershipTransfers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { logger } from "../../common/logger/logger.service";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import { syncStructuralRoleAssignment } from "../../common/rbac/sync-structural-role";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  assertModuleOwnerRoleAssigned,
  revokeModuleOwnerRole,
} from "./module-owner-role.helper";
import {
  fetchMembershipByUser,
  resolveMembershipUserIds,
} from "./ownership-members.helper";
import type { DeclineTransferInput } from "./dto/ownership.schemas";
import type { NotificationEventKey } from "../notifications/notification-events.catalog";

@Injectable()
export class OwnershipTransferResponseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private async invalidateUserAccess(
    orgId: string,
    userId: string,
  ): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    await bustMembershipStatusCache(this.cache, userId, orgId);
  }

  private invalidateTransferCaches(
    orgId: string,
    moduleKey: string | null,
  ): Promise<unknown[]> {
    return Promise.all([
      ...(moduleKey
        ? [
            this.cache.invalidateForOrg(orgId, `module-access:ownership:${moduleKey}`),
          ]
        : []),
      this.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers"),
    ]);
  }

  async acceptTransfer(orgId: string, actorUserId: string, transferId: string) {
    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        initiatedByMembershipId: ownershipTransfers.initiatedByMembershipId,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        expiresAt: ownershipTransfers.expiresAt,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") {
      throw new BadRequestException(
        `Transfer is already ${transfer.status.toLowerCase()}`,
      );
    }
    if (transfer.expiresAt < new Date()) {
      await this.db
        .update(ownershipTransfers)
        .set({ status: "EXPIRED" })
        .where(eq(ownershipTransfers.id, transferId));
      throw new BadRequestException("Transfer has expired");
    }

    const recipientMembership = await fetchMembershipByUser(
      this.db,
      orgId,
      actorUserId,
    );
    if (!recipientMembership)
      throw new ForbiddenException("Not a member of this organization");
    if (recipientMembership.id !== transfer.toMembershipId) {
      throw new ForbiddenException(
        "Only the designated recipient may accept this transfer",
      );
    }
    if (recipientMembership.status !== "ACTIVE") {
      throw new BadRequestException(
        "Your membership must be ACTIVE to accept a transfer",
      );
    }

    const fromUserId =
      transfer.scope === "ORGANIZATION"
        ? await this.applyOrgTransfer(
            orgId,
            transferId,
            transfer.fromMembershipId,
            transfer.toMembershipId,
          )
        : await this.applyModuleTransfer(
            orgId,
            transferId,
            transfer.moduleKey,
            transfer.fromMembershipId,
            transfer.toMembershipId,
          );

    await this.invalidateUserAccess(orgId, actorUserId);
    await this.invalidateUserAccess(orgId, fromUserId);

    const moduleKeyForAccept =
      transfer.scope === "MODULE" ? transfer.moduleKey : null;
    await Promise.all([
      ...(moduleKeyForAccept
        ? [
            this.cache.invalidateForOrg(orgId, "ownership:modules"),
            this.cache.invalidateForOrg(orgId, `ownership:module:${moduleKeyForAccept}`),
          ]
        : []),
      this.invalidateTransferCaches(orgId, moduleKeyForAccept),
    ]);

    this.audit.log({
      action: "ownership.transfer_accepted",
      userId: actorUserId,
      orgId,
      targetId: transferId,
      targetType: "ownership_transfer",
      metadata: {
        transferId,
        scope: transfer.scope,
        moduleKey: transfer.moduleKey ?? undefined,
        initiatedByMembershipId: transfer.initiatedByMembershipId,
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
      },
    });

    const subject =
      transfer.scope === "ORGANIZATION"
        ? "the organization"
        : `the ${transfer.moduleKey} module`;
    void this.dispatch
      .emit({
        eventKey: "ownership.transfer.accepted",
        orgId,
        actorUserId,
        targetUserIds: [fromUserId],
        entityType: "ownership_transfer",
        entityId: transferId,
        title: "Ownership transfer accepted",
        message: `Your ownership of ${subject} has been transferred and is now held by the person you nominated. Your own permissions have changed.`,
        link: "/settings/organization",
      })
      .catch((error: unknown) => {
        logger.error("ownership transfer accepted notification failed", {
          error,
          transferId,
        });
      });

    return { success: true as const };
  }

  private applyOrgTransfer(
    orgId: string,
    transferId: string,
    fromMembershipId: number,
    toMembershipId: number,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .select({ ownerMembershipId: organizations.ownerMembershipId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update");
      if (!org) throw new NotFoundException("Organization not found");

      const memberships = await tx
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          isOwner: organizationMembers.isOwner,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            or(
              eq(organizationMembers.id, fromMembershipId),
              eq(organizationMembers.id, toMembershipId),
            ),
          ),
        )
        .for("update");

      const fromMember = memberships.find((m) => m.id === fromMembershipId);
      const toMember = memberships.find((m) => m.id === toMembershipId);

      if (!fromMember)
        throw new BadRequestException("Initiating member no longer exists");
      const isCurrentOwner =
        fromMember.isOwner ||
        (org.ownerMembershipId != null &&
          org.ownerMembershipId === fromMember.id);
      if (!isCurrentOwner) {
        throw new BadRequestException(
          "Organization ownership changed since this transfer was initiated; it can no longer be accepted",
        );
      }
      if (!toMember || toMember.status !== "ACTIVE") {
        throw new BadRequestException(
          "Recipient membership is no longer active",
        );
      }

      await tx
        .update(organizationMembers)
        .set({ isOwner: false, role: ORG_MEMBER_ROLES.ORG_ADMIN })
        .where(eq(organizationMembers.id, fromMember.id));
      await syncStructuralRoleAssignment(
        tx,
        orgId,
        fromMember.id,
        ORG_MEMBER_ROLES.ORG_ADMIN,
      );
      await tx
        .update(organizationMembers)
        .set({ isOwner: true, role: "OWNER", status: "ACTIVE" })
        .where(eq(organizationMembers.id, toMember.id));
      await tx
        .update(organizations)
        .set({ ownerMembershipId: toMember.id })
        .where(eq(organizations.id, orgId));

      const [accepted] = await tx
        .update(ownershipTransfers)
        .set({ status: "ACCEPTED", respondedAt: new Date() })
        .where(
          and(
            eq(ownershipTransfers.id, transferId),
            eq(ownershipTransfers.orgId, orgId),
            eq(ownershipTransfers.status, "PENDING"),
          ),
        )
        .returning({ id: ownershipTransfers.id });
      if (!accepted)
        throw new ConflictException(
          "Transfer is no longer pending; a concurrent response committed first",
        );

      await bumpPermissionsVersion(tx, orgId);
      return fromMember.userId;
    });
  }

  private applyModuleTransfer(
    orgId: string,
    transferId: string,
    moduleKey: string | null,
    fromMembershipId: number,
    toMembershipId: number,
  ): Promise<string> {
    if (!moduleKey)
      throw new BadRequestException("Invalid transfer: missing module key");

    return this.db.transaction(async (tx) => {
      const [currentOwnership] = await tx
        .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
        .from(moduleOwnerships)
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.moduleKey, moduleKey),
          ),
        )
        .for("update");

      if (!currentOwnership || currentOwnership.ownerMembershipId !== fromMembershipId) {
        throw new BadRequestException(
          "Module ownership changed since this transfer was initiated; it can no longer be accepted",
        );
      }

      const memberships = await tx
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            or(
              eq(organizationMembers.id, fromMembershipId),
              eq(organizationMembers.id, toMembershipId),
            ),
          ),
        )
        .for("update");

      const fromMember = memberships.find((m) => m.id === fromMembershipId);
      const toMember = memberships.find((m) => m.id === toMembershipId);

      if (!fromMember)
        throw new BadRequestException("Expected current owner's membership no longer exists");
      if (!toMember || toMember.status !== "ACTIVE") {
        throw new BadRequestException(
          "Recipient membership is no longer active",
        );
      }

      await tx
        .insert(moduleOwnerships)
        .values({
          orgId,
          moduleKey,
          ownerMembershipId: toMember.id,
        })
        .onConflictDoUpdate({
          target: [moduleOwnerships.orgId, moduleOwnerships.moduleKey],
          set: {
            ownerMembershipId: toMember.id,
            updatedAt: new Date(),
          },
        });

      await revokeModuleOwnerRole(tx, orgId, moduleKey, fromMember.id);
      await assertModuleOwnerRoleAssigned(tx, orgId, moduleKey, toMember.id);

      const [accepted] = await tx
        .update(ownershipTransfers)
        .set({ status: "ACCEPTED", respondedAt: new Date() })
        .where(
          and(
            eq(ownershipTransfers.id, transferId),
            eq(ownershipTransfers.orgId, orgId),
            eq(ownershipTransfers.status, "PENDING"),
          ),
        )
        .returning({ id: ownershipTransfers.id });
      if (!accepted)
        throw new ConflictException(
          "Transfer is no longer pending; a concurrent response committed first",
        );

      await bumpPermissionsVersion(tx, orgId);
      return fromMember.userId;
    });
  }

  async declineTransfer(
    orgId: string,
    actorUserId: string,
    transferId: string,
    input: DeclineTransferInput,
  ) {
    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") {
      throw new BadRequestException(
        `Transfer is already ${transfer.status.toLowerCase()}`,
      );
    }

    const recipientMembership = await fetchMembershipByUser(
      this.db,
      orgId,
      actorUserId,
    );
    if (!recipientMembership)
      throw new ForbiddenException("Not a member of this organization");
    if (recipientMembership.id !== transfer.toMembershipId) {
      throw new ForbiddenException(
        "Only the designated recipient may decline this transfer",
      );
    }

    const [declined] = await this.db
      .update(ownershipTransfers)
      .set({
        status: "DECLINED",
        respondedAt: new Date(),
        reason: input.reason ?? null,
      })
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .returning({ id: ownershipTransfers.id });
    if (!declined)
      throw new ConflictException(
        "Transfer is no longer pending; a concurrent response committed first",
      );

    await this.invalidateTransferCaches(
      orgId,
      transfer.scope === "MODULE" ? transfer.moduleKey : null,
    );

    this.audit.log({
      action: "ownership.transfer_declined",
      userId: actorUserId,
      orgId,
      targetId: transferId,
      targetType: "ownership_transfer",
      metadata: {
        transferId,
        scope: transfer.scope,
        moduleKey: transfer.moduleKey ?? undefined,
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
        reason: input.reason,
      },
    });

    await this.notifyResponders(
      orgId,
      actorUserId,
      transferId,
      transfer.fromMembershipId,
      {
        eventKey: "ownership.transfer.declined",
        title: "Ownership transfer declined",
        message: input.reason
          ? `Your ownership transfer request was declined. Reason: ${input.reason}`
          : "Your ownership transfer request was declined. Ownership is unchanged.",
      },
    ).catch((error: unknown) => {
      logger.error("ownership transfer declined notification failed", {
        error,
        transferId,
      });
    });

    return { success: true as const };
  }

  async cancelTransfer(
    orgId: string,
    actorUserId: string,
    transferId: string,
    isOrgOwner: boolean,
  ) {
    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        initiatedByMembershipId: ownershipTransfers.initiatedByMembershipId,
        status: ownershipTransfers.status,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        toMembershipId: ownershipTransfers.toMembershipId,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") {
      throw new BadRequestException(
        `Transfer is already ${transfer.status.toLowerCase()}`,
      );
    }

    const actorMembership = await fetchMembershipByUser(
      this.db,
      orgId,
      actorUserId,
    );
    if (!actorMembership)
      throw new ForbiddenException("Not a member of this organization");

    const initiatorId = transfer.initiatedByMembershipId;
    if (!isOrgOwner && actorMembership.id !== initiatorId) {
      throw new ForbiddenException(
        "Only the initiator or an org owner may cancel this transfer",
      );
    }

    const [cancelled] = await this.db
      .update(ownershipTransfers)
      .set({ status: "CANCELLED" })
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .returning({ id: ownershipTransfers.id });
    if (!cancelled)
      throw new ConflictException(
        "Transfer is no longer pending; a concurrent response committed first",
      );

    await this.invalidateTransferCaches(
      orgId,
      transfer.scope === "MODULE" ? transfer.moduleKey : null,
    );

    this.audit.log({
      action: "ownership.transfer_cancelled",
      userId: actorUserId,
      orgId,
      targetId: transferId,
      targetType: "ownership_transfer",
      metadata: {
        transferId,
        scope: transfer.scope,
        moduleKey: transfer.moduleKey ?? undefined,
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
      },
    });

    await this.notifyResponders(
      orgId,
      actorUserId,
      transferId,
      transfer.toMembershipId,
      {
        eventKey: "ownership.transfer.cancelled",
        title: "Ownership transfer withdrawn",
        message:
          "The ownership transfer nominating you was withdrawn. No action is needed.",
      },
    ).catch((error: unknown) => {
      logger.error("ownership transfer withdrawn notification failed", {
        error,
        transferId,
      });
    });

    return { success: true as const };
  }

  private async notifyResponders(
    orgId: string,
    actorUserId: string,
    transferId: string,
    membershipId: number,
    payload: { eventKey: NotificationEventKey; title: string; message: string },
  ): Promise<void> {
    const targetUserIds = await resolveMembershipUserIds(this.db, orgId, [
      membershipId,
    ]);
    if (targetUserIds.length === 0) return;

    await this.dispatch.emit({
      eventKey: payload.eventKey,
      orgId,
      actorUserId,
      targetUserIds,
      entityType: "ownership_transfer",
      entityId: transferId,
      title: payload.title,
      message: payload.message,
      link: "/settings/organization",
    });
  }
}
