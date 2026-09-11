import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { moduleOwnerships, ownershipTransfers } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../common/tenant";
import { logger } from "../../../common/logger/logger.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { fetchMembershipById, fetchMembershipByUser } from "../ownership-members.helper";
import type {
  InitiateModuleTransferInput,
  InitiateOrgTransferInput,
} from "../dto/ownership.schemas";
import { canTransferModuleOwnership } from "../../module-access/module-standing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * Opening a transfer: the half that decides who may nominate whom.
 *
 * Everything here runs before any transfer exists, so it can assume nothing and
 * has to establish everything — that the actor is a member, that they hold the
 * authority being handed over (org owner for the organisation, module-transfer
 * standing for a module), that they are not nominating themselves, and that the
 * nominee is an ACTIVE membership in the same org. The partial unique index on
 * pending transfers is the last of those checks and the only one the database
 * makes, which is why both translate 23505 into 409. The listing half left on
 * OwnershipTransfersService asks none of that: it is a cached, paginated read
 * over rows this file has already vouched for.
 */
export interface TransferInitiationDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly cache: CacheService;
  readonly dispatch: NotificationDispatchService;
}

export async function initiateOrgTransfer(
  deps: TransferInitiationDeps,
  orgId: string,
  actorUserId: string,
  input: InitiateOrgTransferInput,
) {
  const actorMembership = await fetchMembershipByUser(
    deps.db,
    orgId,
    actorUserId,
  );
  if (!actorMembership)
    throw new ForbiddenException("Not a member of this organization");
  if (!actorMembership.isOwner)
    throw new ForbiddenException(
      "Only the org owner can initiate an org ownership transfer",
    );

  if (actorMembership.id === input.toMembershipId) {
    throw new BadRequestException("Cannot transfer ownership to yourself");
  }

  const target = await fetchMembershipById(
    deps.db,
    orgId,
    input.toMembershipId,
  );
  if (!target)
    throw new NotFoundException(
      "Target membership not found in this organization",
    );
  if (target.status !== "ACTIVE") {
    throw new BadRequestException(
      "Target membership must be ACTIVE to receive ownership",
    );
  }

  const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);

  try {
    const [transfer] = await deps.db
      .insert(ownershipTransfers)
      .values({
        orgId,
        scope: "ORGANIZATION",
        moduleKey: null,
        fromMembershipId: actorMembership.id,
        initiatedByMembershipId: actorMembership.id,
        toMembershipId: input.toMembershipId,
        status: "PENDING",
        expiresAt,
        reason: input.reason ?? null,
      })
      .returning({
        id: ownershipTransfers.id,
        expiresAt: ownershipTransfers.expiresAt,
      });

    if (!transfer) throw new Error("Insert returned no rows");

    deps.audit.log({
      action: "ownership.org_transfer_initiated",
      userId: actorUserId,
      orgId,
      targetId: String(input.toMembershipId),
      targetType: "membership",
      metadata: {
        transferId: transfer.id,
        initiatedByMembershipId: actorMembership.id,
        fromMembershipId: actorMembership.id,
        toMembershipId: input.toMembershipId,
        expiresAt,
      },
    });

    await deps.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers");

    const notifyOrg = () =>
      notifyRequested(
        deps,
        orgId,
        actorUserId,
        transfer.id,
        target.userId,
        "the entire organization",
      ).catch((error: unknown) => {
        logger.error("ownership transfer notification failed", {
          error,
          transferId: transfer.id,
          scope: "organization",
        });
      });
    if (!registerAfterCommit(notifyOrg)) void notifyOrg();

    return { transferId: transfer.id, expiresAt: transfer.expiresAt };
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      throw new ConflictException(
        "A pending org ownership transfer already exists",
      );
    }
    throw err;
  }
}

export async function initiateModuleTransfer(
  deps: TransferInitiationDeps,
  orgId: string,
  actorUserId: string,
  moduleKey: string,
  input: InitiateModuleTransferInput,
  actor: CurrentUserContext,
) {
  const actorMembership = await fetchMembershipByUser(
    deps.db,
    orgId,
    actorUserId,
  );
  if (!actorMembership)
    throw new ForbiddenException("Not a member of this organization");

  const [currentOwnership] = await deps.db
    .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
    .from(moduleOwnerships)
    .where(
      and(
        eq(moduleOwnerships.orgId, orgId),
        eq(moduleOwnerships.moduleKey, moduleKey),
      ),
    )
    .limit(1);

  if (!currentOwnership) {
    throw new NotFoundException("Module ownership record not found");
  }

  const canTransfer = await canTransferModuleOwnership(deps.db, actor, moduleKey);
  if (!canTransfer) {
    throw new ForbiddenException(
      "Only the module owner, an org admin, or the org owner may initiate a module ownership transfer",
    );
  }

  if (currentOwnership.ownerMembershipId === input.toMembershipId) {
    throw new BadRequestException(
      "Cannot transfer module ownership to the current owner; they already hold it",
    );
  }

  const target = await fetchMembershipById(
    deps.db,
    orgId,
    input.toMembershipId,
  );
  if (!target)
    throw new NotFoundException(
      "Target membership not found in this organization",
    );
  if (target.status !== "ACTIVE") {
    throw new BadRequestException(
      "Target membership must be ACTIVE to receive module ownership",
    );
  }

  const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);

  try {
    const [transfer] = await deps.db
      .insert(ownershipTransfers)
      .values({
        orgId,
        scope: "MODULE",
        moduleKey,
        fromMembershipId: currentOwnership.ownerMembershipId,
        initiatedByMembershipId: actorMembership.id,
        toMembershipId: input.toMembershipId,
        status: "PENDING",
        expiresAt,
        reason: input.reason ?? null,
      })
      .returning({
        id: ownershipTransfers.id,
        expiresAt: ownershipTransfers.expiresAt,
      });

    if (!transfer) throw new Error("Insert returned no rows");

    deps.audit.log({
      action: "ownership.module_transfer_initiated",
      userId: actorUserId,
      orgId,
      targetId: String(input.toMembershipId),
      targetType: "membership",
      metadata: {
        transferId: transfer.id,
        moduleKey,
        initiatedByMembershipId: actorMembership.id,
        fromMembershipId: currentOwnership.ownerMembershipId,
        toMembershipId: input.toMembershipId,
        expiresAt,
      },
    });

    await Promise.all([
      deps.cache.invalidateForOrg(orgId, `module-access:ownership:${moduleKey}`),
      deps.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers"),
    ]);

    const notifyModule = () =>
      notifyRequested(
        deps,
        orgId,
        actorUserId,
        transfer.id,
        target.userId,
        `the ${moduleKey} module`,
      ).catch((error: unknown) => {
        logger.error("ownership transfer notification failed", {
          error,
          transferId: transfer.id,
          scope: moduleKey,
        });
      });
    if (!registerAfterCommit(notifyModule)) void notifyModule();

    return { transferId: transfer.id, expiresAt: transfer.expiresAt };
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      throw new ConflictException(
        `A pending transfer for module "${moduleKey}" already exists`,
      );
    }
    throw err;
  }
}

function notifyRequested(
  deps: TransferInitiationDeps,
  orgId: string,
  actorUserId: string,
  transferId: string,
  recipientUserId: string,
  subject: string,
): Promise<unknown> {
  return deps.dispatch.emit({
    eventKey: "ownership.transfer.requested",
    orgId,
    actorUserId,
    targetUserIds: [recipientUserId],
    entityType: "ownership_transfer",
    entityId: transferId,
    title: "You have been nominated as owner",
    message: `You have been nominated to take over ownership of ${subject}. Review and respond before the request expires.`,
    link: "/settings/incoming-transfer",
  });
}
