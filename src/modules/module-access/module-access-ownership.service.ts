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
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertManagedModule,
  assertModuleEnabled,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import { canTransferModuleOwnership } from "./module-standing";
import { moduleOwnershipDenied } from "./module-access-errors";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";

export interface ModuleOwnership {
  moduleKey: string;
  ownerId: string;
  ownerDisplayName: string;
  ownerEmail: string;
  pendingTransfer: {
    transferId: string;
    toUserId: string;
    toDisplayName: string;
    toEmail: string;
    initiatedAt: string;
  } | null;
}

@Injectable()
export class ModuleAccessOwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async assertOwnershipRights(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleEnabled(
      moduleAccessPolicyDeps(this.db, this.access),
      actor.orgId,
      moduleKey,
    );
    if (await canTransferModuleOwnership(this.db, actor, moduleKey)) return;
    throw moduleOwnershipDenied();
  }

  async getOwnership(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleOwnership> {
    await this.assertOwnershipRights(actor, moduleKey);
    return this.cache.cached(
      CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
      () => this.fetchOwnership(actor.orgId, moduleKey),
      60,
    );
  }

  async initiateTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
    toUserId: string,
  ): Promise<{ success: true }> {
    await this.assertOwnershipRights(actor, moduleKey);
    const orgId = actor.orgId;
    const actorUserId = actor.userId;

    const [actorMembership, toMembership] = await Promise.all([
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, actorUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
        columns: { id: true },
      }),
      this.db.query.organizationMembers.findFirst({
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

    const [currentOwnership] = await this.db
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
        this.db,
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
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "23505"
      ) {
        throw new ConflictException(
          `A pending transfer for module "${moduleKey}" already exists`,
        );
      }
      throw err;
    }

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKey)),
      this.cache.invalidateNamespace(`ownership:transfers:${orgId}`),
    ]);

    this.audit.log({
      action: "module_access.ownership_transfer_initiated",
      userId: actorUserId,
      orgId,
      targetId: String(toMembership.id),
      targetType: "membership",
      metadata: { moduleKey, toUserId },
    });

    return { success: true };
  }

  async cancelTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<{ success: true }> {
    await this.assertOwnershipRights(actor, moduleKey);

    const [transfer] = await this.db
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
      const actorMembership = await this.db.query.organizationMembers.findFirst(
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
      this.db,
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
      this.cache.invalidate(
        CACHE_KEYS.moduleAccessOwnership(actor.orgId, moduleKey),
      ),
      this.cache.invalidateNamespace(`ownership:transfers:${actor.orgId}`),
    ]);

    this.audit.log({
      action: "module_access.ownership_transfer_cancelled",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: transfer.id,
      targetType: "ownership_transfer",
      metadata: { moduleKey },
    });

    return { success: true };
  }

  private async fetchOwnership(
    orgId: string,
    moduleKey: string,
  ): Promise<ModuleOwnership> {
    const [ownerRow] = await this.db
      .select({
        ownerUserId: organizationMembers.userId,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerName: users.name,
        ownerEmail: users.email,
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

    if (!ownerRow)
      throw new NotFoundException("Module ownership not configured");

    const [pendingRow] = await this.db
      .select({
        id: ownershipTransfers.id,
        toMembershipId: ownershipTransfers.toMembershipId,
        initiatedAt: ownershipTransfers.initiatedAt,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.moduleKey, moduleKey),
          eq(ownershipTransfers.scope, "MODULE"),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .limit(1);

    let pendingTransfer: ModuleOwnership["pendingTransfer"] = null;

    if (pendingRow) {
      const [toMember] = await this.db
        .select({
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, pendingRow.toMembershipId),
          ),
        )
        .limit(1);

      if (toMember) {
        pendingTransfer = {
          transferId: pendingRow.id,
          toUserId: toMember.userId,
          toDisplayName: toMember.name ?? toMember.email ?? toMember.userId,
          toEmail: toMember.email ?? "",
          initiatedAt: pendingRow.initiatedAt.toISOString(),
        };
      }
    }

    return {
      moduleKey,
      ownerId: ownerRow.ownerUserId,
      ownerDisplayName:
        ownerRow.ownerName ?? ownerRow.ownerEmail ?? ownerRow.ownerUserId,
      ownerEmail: ownerRow.ownerEmail ?? "",
      pendingTransfer,
    };
  }
}
