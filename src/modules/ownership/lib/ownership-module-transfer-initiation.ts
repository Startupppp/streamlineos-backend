import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { moduleOwnerships, ownershipTransfers } from "../../../db/schema";
import { registerAfterCommit } from "../../../common/tenant";
import { logger } from "../../../common/logger/logger.service";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import { fetchMembershipById, fetchMembershipByUser } from "../ownership-members.helper";
import type { InitiateModuleTransferInput } from "../dto/ownership.schemas";
import { canTransferModuleOwnership } from "../../module-access/module-standing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { notifyRequested, type TransferInitiationDeps } from "./ownership-transfer-initiation";

/**
 * Opening a MODULE ownership transfer.
 *
 * The organisation half, and the reasoning both halves share, are in
 * ownership-transfer-initiation.ts. What differs here is who may nominate:
 * module-transfer standing (canTransferModuleOwnership) rather than being the
 * org owner. The transfer also hands over from the module's CURRENT owner,
 * who need not be the actor. Its pending-transfer guard is its own partial
 * unique index, translated into 409 the same way.
 */
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
    /**
     * `uniq_ownership_xfers_org_pending_module` — (org_id, module_key) WHERE
     * status = 'PENDING' AND scope = 'MODULE'. Same shape, same silence.
     */
    if (getPostgresErrorCode(err) === "23505") {
      throw new ConflictException(
        `A pending transfer for module "${moduleKey}" already exists`,
      );
    }
    throw err;
  }
}
