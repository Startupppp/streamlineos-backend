import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ownershipTransfers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import { bustMembershipAfterOwnershipChange } from "../../common/org/membership-bust";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  fetchMembershipByUser,
  resolveMembershipUserIds,
} from "./ownership-members.helper";
import { canTransferModuleOwnership } from "../module-access/module-standing";
import { principalIsOrgOwner } from "../../common/auth/principal";
import { OrganizationSagaService } from "../organization/core/lifecycle/organization-saga.service";
import {
  acceptOwnershipTransfer,
  type OwnershipTransferAcceptDeps,
} from "./lib/ownership-transfer-accept";
import type { DeclineTransferInput } from "./dto/ownership.schemas";
import type { NotificationEventKey } from "../notifications/notification-events.catalog";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class OwnershipTransferResponseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly saga: OrganizationSagaService,
  ) {}

  /**
   * The named operation, not the primitive underneath it. Both call sites run
   * AFTER the transfer has committed, so `bustMembershipAfterOwnershipChange`
   * busts the session key and then schedules the membership bust, falling back
   * to running it inline when there is no ambient context — which is the case
   * here. `check:membership-writes` bans the primitive import precisely so a
   * caller cannot bust for one half of a change and forget the other.
   */
  private invalidateUserAccess(orgId: string, userId: string): Promise<void> {
    return bustMembershipAfterOwnershipChange(this.cache, orgId, userId);
  }

  private invalidateTransferCaches(orgId: string, moduleKey: string | null): Promise<unknown[]> {
    return Promise.all([
      ...(moduleKey
        ? [this.cache.invalidateForOrg(orgId, `module-access:ownership:${moduleKey}`)]
        : []),
      this.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers"),
    ]);
  }

  private get acceptDeps(): OwnershipTransferAcceptDeps {
    return {
      db: this.db,
      audit: this.audit,
      cache: this.cache,
      dispatch: this.dispatch,
      saga: this.saga,
      invalidateUserAccess: (orgId, userId) => this.invalidateUserAccess(orgId, userId),
      invalidateTransferCaches: (orgId, moduleKey) =>
        this.invalidateTransferCaches(orgId, moduleKey),
    };
  }

  acceptTransfer(orgId: string, actorUserId: string, transferId: string) {
    return acceptOwnershipTransfer(this.acceptDeps, orgId, actorUserId, transferId);
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
      throw new BadRequestException(`Transfer is already ${transfer.status.toLowerCase()}`);
    }

    const recipientMembership = await fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!recipientMembership)
      throw new ForbiddenException("Not a member of this organization");
    if (recipientMembership.id !== transfer.toMembershipId) {
      throw new ForbiddenException("Only the designated recipient may decline this transfer");
    }

    const [declined] = await this.db
      .update(ownershipTransfers)
      .set({ status: "DECLINED", respondedAt: new Date(), reason: input.reason ?? null })
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .returning({ id: ownershipTransfers.id });
    if (!declined)
      throw new ConflictException("Transfer is no longer pending; a concurrent response committed first");

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

    await this.notifyResponders(orgId, actorUserId, transferId, transfer.fromMembershipId, {
      eventKey: "ownership.transfer.declined",
      title: "Ownership transfer declined",
      message: input.reason
        ? `Your ownership transfer request was declined. Reason: ${input.reason}`
        : "Your ownership transfer request was declined. Ownership is unchanged.",
    }).catch((error: unknown) => {
      logger.error("ownership transfer declined notification failed", { error, transferId });
    });

    return { success: true as const };
  }

  async cancelTransfer(
    orgId: string,
    actorUserId: string,
    transferId: string,
    actor: CurrentUserContext,
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
      throw new BadRequestException(`Transfer is already ${transfer.status.toLowerCase()}`);
    }

    const actorMembership = await fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!actorMembership)
      throw new ForbiddenException("Not a member of this organization");

    const initiatorId = transfer.initiatedByMembershipId;
    let canCancel = actorMembership.id === initiatorId;

    if (!canCancel) {
      if (transfer.scope === "MODULE" && transfer.moduleKey !== null) {
        canCancel = await canTransferModuleOwnership(this.db, actor, transfer.moduleKey);
      } else {
        canCancel = principalIsOrgOwner(actor.principal);
      }
    }

    if (!canCancel) {
      throw new ForbiddenException(
        "Only the initiator, the module owner, an org admin, or the org owner may cancel this transfer",
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
      throw new ConflictException("Transfer is no longer pending; a concurrent response committed first");

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

    await this.notifyResponders(orgId, actorUserId, transferId, transfer.toMembershipId, {
      eventKey: "ownership.transfer.cancelled",
      title: "Ownership transfer withdrawn",
      message: "The ownership transfer nominating you was withdrawn. No action is needed.",
    }).catch((error: unknown) => {
      logger.error("ownership transfer withdrawn notification failed", { error, transferId });
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
    const targetUserIds = await resolveMembershipUserIds(this.db, orgId, [membershipId]);
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
