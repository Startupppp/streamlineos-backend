import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  organizationLegalHolds,
  organizations,
  ownershipTransfers,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import { logger } from "../../../common/logger/logger.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { assertTransitionAllowed } from "../../organization/core/lifecycle/organization-lifecycle-transitions";
import type { OrganizationSagaService } from "../../organization/core/lifecycle/organization-saga.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { fetchMembershipByUser } from "../ownership-members.helper";
import { applyModuleTransfer, applyOrgTransfer } from "../ownership-transfer-apply";

/**
 * Accepting a transfer is the only response that moves ownership, and it is
 * the reason this half is separate from declining and cancelling.
 *
 * Decline and cancel stay in OwnershipTransferResponseService: they flip a
 * PENDING row to a terminal status with a conditional UPDATE, report a lost
 * race as 409 Conflict, and leave every ownership row exactly where it was.
 * Accept cannot be that cheap. An ORGANIZATION transfer is an organisation
 * lifecycle event, so it has to clear the status/legal-hold gate through
 * assertTransitionAllowed and run under an OrganizationSagaService saga that
 * can be resumed or compensated; both scopes then rewrite ownership, invalidate
 * the session and membership-standing caches of BOTH people, and only then
 * audit and notify. Expiry is also checked here and nowhere else, because an
 * expired transfer is still perfectly declinable.
 */
export interface OwnershipTransferAcceptDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly cache: CacheService;
  readonly dispatch: NotificationDispatchService;
  readonly saga: OrganizationSagaService;
  /** Busts the session and membership-standing caches for one member. */
  readonly invalidateUserAccess: (orgId: string, userId: string) => Promise<void>;
  /** Busts the transfer-list and per-module ownership namespaces. */
  readonly invalidateTransferCaches: (
    orgId: string,
    moduleKey: string | null,
  ) => Promise<unknown[]>;
}

export async function acceptOwnershipTransfer(
  deps: OwnershipTransferAcceptDeps,
  orgId: string,
  actorUserId: string,
  transferId: string,
) {
  const [transfer] = await deps.db
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
    await deps.db
      .update(ownershipTransfers)
      .set({ status: "EXPIRED" })
      .where(eq(ownershipTransfers.id, transferId));
    throw new BadRequestException("Transfer has expired");
  }

  const recipientMembership = await fetchMembershipByUser(deps.db, orgId, actorUserId);
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
      deps.db,
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

    const sagaCtx = await deps.saga.begin(
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
        await deps.saga.runStep(sagaCtx.saga.sagaId, "validate-new-owner", () => Promise.resolve());

      if (!done.has("transfer-ownership"))
        fromUserId = await deps.saga.runStep(
          sagaCtx.saga.sagaId,
          "transfer-ownership",
          () => applyOrgTransfer(deps.db, deps.cache, orgId, transferId, transfer.fromMembershipId, transfer.toMembershipId),
        );

      await deps.saga.complete(sagaCtx.saga.sagaId);
    } catch (err) {
      await deps.saga.compensate(sagaCtx.saga.sagaId, {});
      throw err;
    }

    if (fromUserId !== undefined) {
      await deps.invalidateUserAccess(orgId, actorUserId);
      await deps.invalidateUserAccess(orgId, fromUserId);
      await Promise.all([
        deps.cache.invalidateForOrg(orgId, "ownership:modules"),
        deps.invalidateTransferCaches(orgId, null),
      ]);

      deps.audit.log({
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

      void deps.dispatch
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
    deps.db,
    orgId,
    transferId,
    transfer.moduleKey,
    transfer.fromMembershipId,
    transfer.toMembershipId,
  );

  await deps.invalidateUserAccess(orgId, actorUserId);
  await deps.invalidateUserAccess(orgId, fromUserId);

  const moduleKeyForAccept = transfer.moduleKey;
  await Promise.all([
    ...(moduleKeyForAccept
      ? [
          deps.cache.invalidateForOrg(orgId, "ownership:modules"),
          deps.cache.invalidateForOrg(orgId, `ownership:module:${moduleKeyForAccept}`),
        ]
      : []),
    deps.invalidateTransferCaches(orgId, moduleKeyForAccept),
  ]);

  deps.audit.log({
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

  void deps.dispatch
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
