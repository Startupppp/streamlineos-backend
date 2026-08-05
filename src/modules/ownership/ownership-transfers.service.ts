import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, lt } from "drizzle-orm";
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
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { stableHash } from "../../common/cache/cache-hash";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  fetchMembershipById,
  fetchMembershipByUser,
  resolveMembershipUserIds,
} from "./ownership-members.helper";
import type {
  InitiateModuleTransferInput,
  InitiateOrgTransferInput,
  ListTransfersInput,
} from "./dto/ownership.schemas";

@Injectable()
export class OwnershipTransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async initiateOrgTransfer(
    orgId: string,
    actorUserId: string,
    input: InitiateOrgTransferInput,
  ) {
    const actorMembership = await fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!actorMembership) throw new ForbiddenException("Not a member of this organization");
    if (!actorMembership.isOwner) throw new ForbiddenException("Only the org owner can initiate an org ownership transfer");

    if (actorMembership.id === input.toMembershipId) {
      throw new BadRequestException("Cannot transfer ownership to yourself");
    }

    const target = await fetchMembershipById(this.db, orgId, input.toMembershipId);
    if (!target) throw new NotFoundException("Target membership not found in this organization");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Target membership must be ACTIVE to receive ownership");
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
          toMembershipId: input.toMembershipId,
          status: "PENDING",
          expiresAt,
          reason: input.reason ?? null,
        })
        .returning({ id: ownershipTransfers.id, expiresAt: ownershipTransfers.expiresAt });

      if (!transfer) throw new Error("Insert returned no rows");

      this.audit.log({
        action: "ownership.org_transfer_initiated",
        userId: actorUserId,
        orgId,
        targetId: String(input.toMembershipId),
        targetType: "membership",
        metadata: {
          transferId: transfer.id,
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          expiresAt,
        },
      });

      await this.cache.invalidateNamespace(`ownership:transfers:${orgId}`);

      void this.notifyRequested(
        orgId,
        actorUserId,
        transfer.id,
        target.userId,
        "the entire organization",
      ).catch(() => undefined);

      return { transferId: transfer.id, expiresAt: transfer.expiresAt };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        throw new ConflictException("A pending org ownership transfer already exists");
      }
      throw err;
    }
  }

  async initiateModuleTransfer(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    input: InitiateModuleTransferInput,
    isOrgOwner: boolean,
  ) {
    const actorMembership = await fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!actorMembership) throw new ForbiddenException("Not a member of this organization");

    if (!isOrgOwner) {
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
      if (currentOwnership.ownerMembershipId !== actorMembership.id) {
        throw new ForbiddenException("Only the current module owner or an org owner may initiate a module ownership transfer");
      }
    }

    if (actorMembership.id === input.toMembershipId) {
      throw new BadRequestException("Cannot transfer module ownership to yourself");
    }

    const target = await fetchMembershipById(this.db, orgId, input.toMembershipId);
    if (!target) throw new NotFoundException("Target membership not found in this organization");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Target membership must be ACTIVE to receive module ownership");
    }

    const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);

    try {
      const [transfer] = await this.db
        .insert(ownershipTransfers)
        .values({
          orgId,
          scope: "MODULE",
          moduleKey,
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          status: "PENDING",
          expiresAt,
          reason: input.reason ?? null,
        })
        .returning({ id: ownershipTransfers.id, expiresAt: ownershipTransfers.expiresAt });

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
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          expiresAt,
        },
      });

      await Promise.all([
        this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKey)),
        this.cache.invalidateNamespace(`ownership:transfers:${orgId}`),
      ]);

      void this.notifyRequested(
        orgId,
        actorUserId,
        transfer.id,
        target.userId,
        `the ${moduleKey} module`,
      ).catch(() => undefined);

      return { transferId: transfer.id, expiresAt: transfer.expiresAt };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        throw new ConflictException(`A pending transfer for module "${moduleKey}" already exists`);
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
    return this.cache.cachedVersioned(
      `ownership:transfers:${orgId}`,
      `list:${hash}`,
      () => this.fetchTransfers(orgId, filters),
      60,
    );
  }

  private async fetchTransfers(orgId: string, filters: ListTransfersInput) {
    const offset = (filters.page - 1) * filters.limit;

    const conditions = [eq(ownershipTransfers.orgId, orgId)];
    if (filters.scope) conditions.push(eq(ownershipTransfers.scope, filters.scope));
    if (filters.status) conditions.push(eq(ownershipTransfers.status, filters.status));

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: ownershipTransfers.id,
          scope: ownershipTransfers.scope,
          moduleKey: ownershipTransfers.moduleKey,
          fromMembershipId: ownershipTransfers.fromMembershipId,
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
    return this.cache.cachedVersioned(
      `ownership:transfers:${orgId}`,
      `incoming:${userId}`,
      () => this.fetchIncomingTransfers(orgId, userId),
      60,
    );
  }

  private async fetchIncomingTransfers(orgId: string, userId: string) {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);

    if (!membership) return { data: [] };

    const rows = await this.db
      .select({
        id: ownershipTransfers.id,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
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

  async expireStaleTransfers(orgId?: string): Promise<{ expired: number }> {
    const conditions = [
      eq(ownershipTransfers.status, "PENDING"),
      lt(ownershipTransfers.expiresAt, new Date()),
    ];
    if (orgId) conditions.push(eq(ownershipTransfers.orgId, orgId));

    const rows = await this.db
      .update(ownershipTransfers)
      .set({ status: "EXPIRED" })
      .where(and(...conditions))
      .returning({
        id: ownershipTransfers.id,
        orgId: ownershipTransfers.orgId,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        toMembershipId: ownershipTransfers.toMembershipId,
      });

    const affectedOrgIds = [...new Set(rows.map((r) => r.orgId))];
    await Promise.all(
      affectedOrgIds.map((affectedOrgId) =>
        this.cache.invalidateNamespace(`ownership:transfers:${affectedOrgId}`),
      ),
    );

    for (const row of rows) {
      void this.notifyExpired(row.orgId, row.id, [
        row.fromMembershipId,
        row.toMembershipId,
      ]).catch(() => undefined);
    }

    return { expired: rows.length };
  }

  private async notifyExpired(
    orgId: string,
    transferId: string,
    membershipIds: readonly number[],
  ): Promise<void> {
    const targetUserIds = await resolveMembershipUserIds(this.db, orgId, membershipIds);
    if (targetUserIds.length === 0) return;

    await this.dispatch.emit({
      eventKey: "ownership.transfer.expired",
      orgId,
      targetUserIds,
      entityType: "ownership_transfer",
      entityId: transferId,
      title: "Ownership transfer expired",
      message: "An ownership transfer request expired before it was answered. Ownership is unchanged.",
      link: "/settings/organization",
    });
  }
}
