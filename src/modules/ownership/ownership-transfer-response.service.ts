import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  ownershipTransfers,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { bustMembershipAfterOwnershipChange } from "../../common/org/membership-bust";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { isNull } from "drizzle-orm";
import {
  assertTransitionAllowed,
} from "../organization/core/lifecycle/organization-lifecycle-transitions";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  fetchMembershipByUser,
  resolveMembershipUserIds,
} from "./ownership-members.helper";
import { canTransferModuleOwnership } from "../module-access/module-standing";
import { principalIsOrgOwner } from "../../common/auth/principal";
import { OrganizationSagaService } from "../organization/core/lifecycle/organization-saga.service";
import { organizations, organizationLegalHolds } from "../../db/schema";
import { applyOrgTransfer, applyModuleTransfer } from "./ownership-transfer-apply";
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

  private invalidateTransferCaches(orgId: string, moduleKey: string | null): Promise<unknown[]> {
    return Promise.all([
      ...(moduleKey
        ? [this.cache.invalidateForOrg(orgId, `module-access:ownership:${moduleKey}`)]
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

    const recipientMembership = await fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!recipientMembership)
      throw new ForbiddenException("Not a member of this organization");
    if (recipientMembership.id !== transfer.toMembershipId) {
      throw new ForbiddenException("Only the designated recipient may accept this transfer");
    }
    if (recipientMembership.status !== "ACTIVE") {
      throw new BadRequestException("Your membership must be ACTIVE to accept a transfer");
    }

    if (transfer.scope === "ORGANIZATION") {
      const preflight = await runInTenantTransaction(
        this.db,
        async (tx) => {
          const [org] = await tx
            .select({ statusV2: organizations.statusV2 })
            .from(organizations)
            .where(eq(organizations.id, orgId))
            .limit(1);
          const [hold] = await tx
            .select({ holdId: organizationLegalHolds.holdId })
            .from(organizationLegalHolds)
            .where(
              and(
                eq(organizationLegalHolds.orgId, orgId),
                isNull(organizationLegalHolds.releasedAt),
              ),
            )
            .limit(1);
          return {
            statusV2: org?.statusV2 ?? null,
            hasActiveLegalHold: hold !== undefined,
          };
        },
        { orgId },
      );
      const transition = assertTransitionAllowed(
        "OWNERSHIP_TRANSFER",
        preflight.statusV2 ?? "ACTIVE",
        { hasActiveLegalHold: preflight.hasActiveLegalHold },
      );
      if (!transition.allowed) throw new BadRequestException(transition.reason);

      const sagaCtx = await this.saga.begin(
        "OWNERSHIP_TRANSFER",
        orgId,
        `ownership-transfer:${orgId}:${transferId}`,
        actorUserId,
        preflight.statusV2 ?? "ACTIVE",
      );
      const done = new Set(
        sagaCtx.steps.filter((s) => s.state === "DONE").map((s) => s.stepName),
      );

      let fromUserId: string | undefined;
      try {
        if (!done.has("validate-new-owner"))
          await this.saga.runStep(sagaCtx.saga.sagaId, "validate-new-owner", () => Promise.resolve());

        if (!done.has("transfer-ownership"))
          fromUserId = await this.saga.runStep(
            sagaCtx.saga.sagaId,
            "transfer-ownership",
            () => applyOrgTransfer(this.db, this.cache, orgId, transferId, transfer.fromMembershipId, transfer.toMembershipId),
          );

        await this.saga.complete(sagaCtx.saga.sagaId);
      } catch (err) {
        await this.saga.compensate(sagaCtx.saga.sagaId, {});
        throw err;
      }

      if (fromUserId !== undefined) {
        await this.cache.invalidate(CACHE_KEYS.userSession(actorUserId));
        await this.cache.invalidate(CACHE_KEYS.userSession(fromUserId));
        await Promise.all([
          this.cache.invalidateForOrg(orgId, "ownership:modules"),
          this.invalidateTransferCaches(orgId, null),
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

        void this.dispatch
          .emit({
            eventKey: "ownership.transfer.accepted",
            orgId,
            actorUserId,
            targetUserIds: [fromUserId],
            entityType: "ownership_transfer",
            entityId: transferId,
            title: "Ownership transfer accepted",
            message:
              "Your ownership of the organization has been transferred and is now held by the person you nominated. Your own permissions have changed.",
            link: "/settings/organization",
          })
          .catch((error: unknown) => {
            logger.error("ownership transfer accepted notification failed", { error, transferId });
          });
      }

      return { success: true as const };
    }

    const fromUserId = await applyModuleTransfer(
      this.db,
      orgId,
      transferId,
      transfer.moduleKey,
      transfer.fromMembershipId,
      transfer.toMembershipId,
    );

    await bustMembershipAfterOwnershipChange(this.cache, orgId, actorUserId);
    await bustMembershipAfterOwnershipChange(this.cache, orgId, fromUserId);

    const moduleKeyForAccept = transfer.moduleKey;
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

    void this.dispatch
      .emit({
        eventKey: "ownership.transfer.accepted",
        orgId,
        actorUserId,
        targetUserIds: [fromUserId],
        entityType: "ownership_transfer",
        entityId: transferId,
        title: "Ownership transfer accepted",
        message: `Your ownership of the ${transfer.moduleKey} module has been transferred and is now held by the person you nominated. Your own permissions have changed.`,
        link: "/settings/organization",
      })
      .catch((error: unknown) => {
        logger.error("ownership transfer accepted notification failed", { error, transferId });
      });

    return { success: true as const };
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
