import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
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
import { stableHash } from "../../common/cache/cache-hash";
import { registerAfterCommit } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  fetchMembershipById,
  fetchMembershipByUser,
} from "./ownership-members.helper";
import { OwnershipTransferExpiryService } from "./ownership-transfer-expiry.service";
import type {
  InitiateModuleTransferInput,
  InitiateOrgTransferInput,
  ListTransfersInput,
} from "./dto/ownership.schemas";
import { canTransferModuleOwnership } from "../module-access/module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class OwnershipTransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly expiry: OwnershipTransferExpiryService,
  ) {}

  async initiateOrgTransfer(
    orgId: string,
    actorUserId: string,
    input: InitiateOrgTransferInput,
  ) {
    const actorMembership = await fetchMembershipByUser(
      this.db,
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
      this.db,
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
      const [transfer] = await this.db
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

      this.audit.log({
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

      await this.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers");

      const notifyOrg = () =>
        this.notifyRequested(
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

  async initiateModuleTransfer(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    input: InitiateModuleTransferInput,
    actor: CurrentUserContext,
  ) {
    const actorMembership = await fetchMembershipByUser(
      this.db,
      orgId,
      actorUserId,
    );
    if (!actorMembership)
      throw new ForbiddenException("Not a member of this organization");

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

    if (!currentOwnership) {
      throw new NotFoundException("Module ownership record not found");
    }

    const canTransfer = await canTransferModuleOwnership(this.db, actor, moduleKey);
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
      this.db,
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
      const [transfer] = await this.db
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

      this.audit.log({
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
        this.cache.invalidateForOrg(orgId, `module-access:ownership:${moduleKey}`),
        this.cache.invalidateNamespaceForOrg(orgId, "ownership:transfers"),
      ]);

      const notifyModule = () =>
        this.notifyRequested(
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

  private notifyRequested(
    orgId: string,
    actorUserId: string,
    transferId: string,
    recipientUserId: string,
    subject: string,
  ): Promise<unknown> {
    return this.dispatch.emit({
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

  async listTransfers(orgId: string, filters: ListTransfersInput) {
    const hash = stableHash({
      page: filters.page,
      limit: filters.limit,
      scope: filters.scope ?? null,
      status: filters.status ?? null,
    });
    return this.cache.cachedVersionedForOrg(
      orgId,
      "ownership:transfers",
      `list:${hash}`,
      () => this.fetchTransfers(orgId, filters),
      60,
    );
  }

  private async fetchTransfers(orgId: string, filters: ListTransfersInput) {
    const offset = (filters.page - 1) * filters.limit;

    const conditions = [eq(ownershipTransfers.orgId, orgId)];
    if (filters.scope)
      conditions.push(eq(ownershipTransfers.scope, filters.scope));
    if (filters.status)
      conditions.push(eq(ownershipTransfers.status, filters.status));

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: ownershipTransfers.id,
          scope: ownershipTransfers.scope,
          moduleKey: ownershipTransfers.moduleKey,
          fromMembershipId: ownershipTransfers.fromMembershipId,
          initiatedByMembershipId: ownershipTransfers.initiatedByMembershipId,
          toMembershipId: ownershipTransfers.toMembershipId,
          status: ownershipTransfers.status,
          initiatedAt: ownershipTransfers.initiatedAt,
          respondedAt: ownershipTransfers.respondedAt,
          expiresAt: ownershipTransfers.expiresAt,
          reason: ownershipTransfers.reason,
        })
        .from(ownershipTransfers)
        .where(and(...conditions))
        .orderBy(desc(ownershipTransfers.initiatedAt))
        .limit(filters.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(ownershipTransfers)
        .where(and(...conditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: rows,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  async listIncomingTransfers(orgId: string, userId: string) {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "ownership:transfers",
      `incoming:${userId}`,
      () => this.fetchIncomingTransfers(orgId, userId),
      60,
    );
  }

  private async fetchIncomingTransfers(orgId: string, userId: string) {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!membership) return { data: [] };

    const rows = await this.db
      .select({
        id: ownershipTransfers.id,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        initiatedByMembershipId: ownershipTransfers.initiatedByMembershipId,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        initiatedAt: ownershipTransfers.initiatedAt,
        expiresAt: ownershipTransfers.expiresAt,
        reason: ownershipTransfers.reason,
        fromName: users.name,
        fromEmail: users.email,
      })
      .from(ownershipTransfers)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, ownershipTransfers.fromMembershipId),
          eq(organizationMembers.orgId, orgId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.toMembershipId, membership.id),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .orderBy(desc(ownershipTransfers.initiatedAt))
      .limit(20);

    return { data: rows };
  }

  async expireStaleTransfers(): Promise<{ expired: number }> {
    return this.expiry.expireStaleTransfers();
  }
}
