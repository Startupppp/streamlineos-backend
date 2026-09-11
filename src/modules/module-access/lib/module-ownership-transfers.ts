import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * The initiating side of a module-ownership transfer: opening one and
 * withdrawing it.
 *
 * `module-access-ownership.service.ts` keeps the read — who owns this module,
 * and is a transfer pending — which is cached, never writes, and is what the
 * Access screen's ownership tab renders. These two functions are the only
 * writers of a MODULE-scope `ownership_transfers` row from this surface, and
 * they carry the lifecycle's rules: the target must be an ACTIVE member of the
 * same org, the current owner cannot be the target, a module has at most one
 * PENDING transfer (the partial unique index, surfaced as a 409), a pending
 * transfer expires after 48 hours, and only the member who initiated it or an
 * org owner may withdraw it. Accepting or declining is the other party's side
 * and lives in `modules/ownership/ownership-transfer-response.service.ts`.
 *
 * The gate that decides whether the caller may touch ownership at all is the
 * service's private `assertOwnershipRights`, passed in bound and run first by
 * both functions — so neither is callable without somebody supplying it, and the
 * gate itself stays unexported.
 *
 * Bodies moved verbatim, call order included.
 */

export interface ModuleOwnershipTransferDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: AuditService;
  /** `ModuleAccessOwnershipService.assertOwnershipRights`, bound. Resolves, or throws the refusal. */
  readonly assertOwnershipRights: (
    actor: CurrentUserContext,
    moduleKey: string,
  ) => Promise<void>;
}

export async function initiateModuleOwnershipTransfer(
  deps: ModuleOwnershipTransferDeps,
  actor: CurrentUserContext,
  moduleKey: string,
  toUserId: string,
): Promise<{ success: true }> {
  await deps.assertOwnershipRights(actor, moduleKey);
  const orgId = actor.orgId;
  const actorUserId = actor.userId;

  const [actorMembership, toMembership] = await Promise.all([
    deps.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, actorUserId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    }),
    deps.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, toUserId),
      ),
      columns: { id: true, status: true },
    }),
  ]);

  if (!actorMembership)
    throw new ForbiddenException("Not a member of this organization");
  if (!toMembership)
    throw new NotFoundException(
      "Target user is not a member of this organization",
    );
  if (toMembership.status !== "ACTIVE")
    throw new BadRequestException("Target membership must be ACTIVE");

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
  if (!currentOwnership)
    throw new NotFoundException("Module ownership record not found");
  if (currentOwnership.ownerMembershipId === toMembership.id)
    throw new BadRequestException("That member already owns this module");

  try {
    const expiresAt = new Date(Date.now() + 48 * 3_600_000);
    await runInTenantTransaction(
      deps.db,
      async (tx) => {
        await tx.insert(ownershipTransfers).values({
          orgId,
          scope: "MODULE",
          moduleKey,
          fromMembershipId: currentOwnership.ownerMembershipId,
          initiatedByMembershipId: actorMembership.id,
          toMembershipId: toMembership.id,
          status: "PENDING",
          expiresAt,
          reason: null,
        });
      },
      { orgId },
    );
  } catch (err: unknown) {
    /**
     * `uniq_ownership_xfers_org_pending_module` — (org_id, module_key) WHERE
     * status = 'PENDING' AND scope = 'MODULE'. Nothing looks for an existing
     * pending transfer before inserting, so this is the whole guard, and it
     * was unreachable: Drizzle leaves the SQLSTATE on `.cause`, so a second
     * hand-over of the same module answered 500 instead of 409.
     */
    if (getPostgresErrorCode(err) === "23505") {
      throw new ConflictException(
        `A pending transfer for module "${moduleKey}" already exists`,
      );
    }
    throw err;
  }

  await Promise.all([
    deps.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKey)),
    deps.cache.invalidateNamespace(`ownership:transfers:${orgId}`),
  ]);

  deps.audit.log({
    action: "module_access.ownership_transfer_initiated",
    userId: actorUserId,
    orgId,
    targetId: String(toMembership.id),
    targetType: "membership",
    metadata: { moduleKey, toUserId },
  });

  return { success: true };
}

export async function cancelModuleOwnershipTransfer(
  deps: ModuleOwnershipTransferDeps,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<{ success: true }> {
  await deps.assertOwnershipRights(actor, moduleKey);

  const [transfer] = await deps.db
    .select({
      id: ownershipTransfers.id,
      fromMembershipId: ownershipTransfers.fromMembershipId,
    })
    .from(ownershipTransfers)
    .where(
      and(
        eq(ownershipTransfers.orgId, actor.orgId),
        eq(ownershipTransfers.moduleKey, moduleKey),
        eq(ownershipTransfers.scope, "MODULE"),
        eq(ownershipTransfers.status, "PENDING"),
      ),
    )
    .limit(1);

  if (!transfer)
    throw new NotFoundException("No pending transfer found for this module");

  if (!actor.isOrgOwner) {
    const actorMembership = await deps.db.query.organizationMembers.findFirst(
      {
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, actor.userId),
        ),
        columns: { id: true },
      },
    );
    if (
      !actorMembership ||
      actorMembership.id !== transfer.fromMembershipId
    ) {
      throw new ForbiddenException(
        "Only the transfer initiator or an org owner may cancel this transfer",
      );
    }
  }

  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      await tx
        .update(ownershipTransfers)
        .set({ status: "CANCELLED" })
        .where(
          and(
            eq(ownershipTransfers.id, transfer.id),
            eq(ownershipTransfers.orgId, actor.orgId),
          ),
        );
    },
    { orgId: actor.orgId },
  );

  await Promise.all([
    deps.cache.invalidate(
      CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
    ),
    deps.cache.invalidateNamespace(`ownership:transfers:${actor.orgId}`),
  ]);

  deps.audit.log({
    action: "module_access.ownership_transfer_cancelled",
    userId: actor.userId,
    orgId: actor.orgId,
    targetId: transfer.id,
    targetType: "ownership_transfer",
    metadata: { moduleKey },
  });

  return { success: true };
}
