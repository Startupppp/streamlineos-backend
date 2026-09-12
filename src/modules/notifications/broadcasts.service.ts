import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, desc, exists, lt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  broadcastAudienceTargets,
  broadcasts,
  hrEmployments,
  hrPeople,
  organizationMembers,
  roleAssignments,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { broadcastReadReceipts } from "../../db/schema";
import type { CreateBroadcastInput, UpdateBroadcastInput, ListBroadcastsInput } from "./dto/broadcast.schemas";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import { pageBroadcastRecipients, replaceBroadcastAudienceTargets } from "./broadcasts-audience.queries";
import type { InboxSourcePosition } from "./dto/unified-inbox.schemas";

function broadcastOrderTime() {
  return sql`coalesce(${broadcasts.sentAt}, ${broadcasts.createdAt})`;
}

function broadcastInboxKeyset(cursor: InboxSourcePosition | null) {
  if (cursor === null) return undefined;
  if (cursor.t === null) return lt(broadcasts.id, cursor.id);
  return or(
    sql`${broadcastOrderTime()} < ${cursor.t}::timestamptz`,
    and(
      sql`${broadcastOrderTime()} = ${cursor.t}::timestamptz`,
      lt(broadcasts.id, cursor.id),
    ),
  );
}

@Injectable()
export class BroadcastsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatchService: NotificationDispatchService,
  ) {}

  list(orgId: string, filters: ListBroadcastsInput) {
    return this.cache.cachedVersioned(
      `broadcasts:list:${orgId}`,
      JSON.stringify(filters),
      () => this.queryBroadcasts(orgId, filters),
      CACHE_TTL.SHORT,
    );
  }

  private async queryBroadcasts(orgId: string, filters: ListBroadcastsInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const rows = await this.db
      .select({
        id: broadcasts.id,
        orgId: broadcasts.orgId,
        title: broadcasts.title,
        message: broadcasts.message,
        type: broadcasts.type,
        priority: broadcasts.priority,
        category: broadcasts.category,
        channels: broadcasts.channels,
        audience: broadcasts.audience,
        status: broadcasts.status,
        scheduledAt: broadcasts.scheduledAt,
        sentAt: broadcasts.sentAt,
        recipientCount: broadcasts.recipientCount,
        deliveredCount: broadcasts.deliveredCount,
        createdBy: broadcasts.createdBy,
        createdAt: broadcasts.createdAt,
        updatedAt: broadcasts.updatedAt,
      })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.orgId, orgId),
          filters.status ? eq(broadcasts.status, filters.status) : undefined,
          filters.cursor ? lt(broadcasts.id, filters.cursor) : undefined,
        ),
      )
      .orderBy(desc(broadcasts.id))
      .limit(limit + 1);

    const page = buildIdCursorPage(rows, limit, (row) => row.id);
    return { items: page.data, nextCursor: page.nextCursor };
  }

  async findOne(orgId: string, id: number) {
    const broadcast = await this.db.query.broadcasts.findFirst({
      where: and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)),
    });
    if (!broadcast) throw new NotFoundException(`Broadcast ${id} not found`);
    return broadcast;
  }

  async create(orgId: string, userId: string, dto: CreateBroadcastInput) {
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(broadcasts)
        .values({
          orgId,
          title: dto.title,
          message: dto.message,
          type: dto.type,
          priority: dto.priority,
          category: dto.category,
          channels: dto.channels,
          audience: dto.audience,
          audienceType: dto.audience.type,
          status: "DRAFT",
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
          createdBy: userId,
        })
        .returning();
      if (!row) throw new BadRequestException("Broadcast could not be created");
      await replaceBroadcastAudienceTargets(tx, orgId, row.id, dto.audience);
      return row;
    });
    await this.invalidateCache(orgId);
    return created;
  }

  async update(orgId: string, id: number, userId: string, dto: UpdateBroadcastInput) {
    const existing = await this.findOne(orgId, id);
    if (existing.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT broadcasts can be updated");
    }
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(broadcasts)
        .set({
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.message !== undefined && { message: dto.message }),
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.priority !== undefined && { priority: dto.priority }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.channels !== undefined && { channels: dto.channels }),
          ...(dto.audience !== undefined && { audience: dto.audience, audienceType: dto.audience.type }),
          ...(dto.scheduledAt !== undefined && { scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null }),
        })
        .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)))
        .returning();
      if (dto.audience !== undefined) await replaceBroadcastAudienceTargets(tx, orgId, id, dto.audience);
      return row;
    });
    await this.invalidateCache(orgId);

    this.audit.log({
      action: "notification.broadcast.updated",
      userId,
      orgId,
      targetId: String(id),
      targetType: "broadcast",
      metadata: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.channels !== undefined && { channels: dto.channels }),
        ...(dto.audience !== undefined && { audience: dto.audience }),
        ...(dto.scheduledAt !== undefined && { scheduledAt: dto.scheduledAt }),
        ...(dto.message !== undefined && { messageChanged: true }),
      },
    });

    return updated;
  }

  /**
   * C21-02. Fan-out-on-READ for IN_APP. Publish writes exactly one broadcast row
   * (the status update) rather than one notification row per recipient. Unread state
   * is the absence of a receipt in broadcast_read_receipts — queried lazily per user
   * at the /inbox endpoint.
   *
   * Non-IN_APP channels (EMAIL, PUSH, SMS) go through the dispatch pipeline so
   * preferences, quiet hours and provider delivery all apply. The pipeline writes to
   * the outbox inside the current tenant transaction and drains after commit, so the
   * HTTP request returns immediately regardless of audience size.
   */
  async publish(orgId: string, userId: string, id: number) {
    const broadcast = await this.findOne(orgId, id);
    if (!["DRAFT", "SCHEDULED"].includes(broadcast.status)) {
      throw new BadRequestException("Only DRAFT or SCHEDULED broadcasts can be published");
    }

    if (broadcast.scheduledAt && new Date(broadcast.scheduledAt) > new Date()) {
      const [updated] = await this.db
        .update(broadcasts)
        .set({ status: "SCHEDULED" })
        .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)))
        .returning();
      await this.invalidateCache(orgId);
      return updated;
    }

    const nonInAppChannels = broadcast.channels.filter((c) => c !== "IN_APP");
    let totalRecipients = 0;

    for await (const page of pageBroadcastRecipients(this.db, orgId, broadcast.id, broadcast.audienceType)) {
      totalRecipients += page.length;
      if (nonInAppChannels.length > 0) {
        await this.dispatchService.emit({
          eventKey: "notification.broadcast.published",
          orgId,
          actorUserId: userId,
          notifySelf: true,
          targetUserIds: page,
          title: broadcast.title,
          message: broadcast.message,
          entityType: "broadcast",
          entityId: String(id),
          metadata: { broadcastId: id },
        });
      }
    }

    const [sent] = await this.db
      .update(broadcasts)
      .set({
        status: "SENT",
        sentAt: new Date(),
        recipientCount: totalRecipients,
        deliveredCount: 0,
      })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)))
      .returning();

    if (!sent) throw new BadRequestException("Broadcast could not be sent");

    await this.invalidateCache(orgId);
    return sent;
  }

  /**
   * C21-02. Records a user's dismissal of a broadcast. The unique index on
   * (org_id, broadcast_id, membership_id) makes this idempotent: repeating the call
   * produces exactly one receipt row.
   */
  async dismiss(orgId: string, userId: string, broadcastId: number, membershipId?: number | null) {
    await this.findOne(orgId, broadcastId);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    await this.db
      .insert(broadcastReadReceipts)
      .values({ orgId, broadcastId, membershipId })
      .onConflictDoNothing({
        target: [broadcastReadReceipts.orgId, broadcastReadReceipts.broadcastId, broadcastReadReceipts.membershipId],
      });
    return { success: true };
  }

  private async resolveAudienceFilter(orgId: string, userId: string) {
    const [userRow, roleRows] = await Promise.all([
      this.db
        .select({ deptId: hrEmployments.departmentId })
        .from(users)
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(eq(users.id, userId))
        .limit(1)
        .then((rows) => rows[0]),
      this.db
        .select({ roleId: roleAssignments.roleId })
        .from(roleAssignments)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, roleAssignments.orgId),
            eq(organizationMembers.id, roleAssignments.organizationMembershipId),
            eq(organizationMembers.userId, userId),
          ),
        )
        .where(eq(roleAssignments.orgId, orgId))
        .limit(100),
    ]);

    const userDeptId = userRow?.deptId ?? null;
    const userRoleIdStrs = roleRows.map((r) => String(r.roleId));

    const audienceKindConditions = [
      and(eq(broadcastAudienceTargets.kind, "USER"), eq(broadcastAudienceTargets.targetId, userId)),
      userRoleIdStrs.length > 0
        ? and(
            eq(broadcastAudienceTargets.kind, "ROLE"),
            inArray(broadcastAudienceTargets.targetId, userRoleIdStrs),
          )
        : undefined,
      userDeptId !== null
        ? and(
            eq(broadcastAudienceTargets.kind, "DEPARTMENT"),
            eq(broadcastAudienceTargets.targetId, userDeptId),
          )
        : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const matchingTarget = this.db
      .select({ matched: sql<number>`1` })
      .from(broadcastAudienceTargets)
      .where(
        and(
          eq(broadcastAudienceTargets.orgId, orgId),
          eq(broadcastAudienceTargets.broadcastId, broadcasts.id),
          or(...audienceKindConditions),
        ),
      );

    return or(eq(broadcasts.audienceType, "all"), exists(matchingTarget)) ?? sql`false`;
  }

  /**
   * C21-02. Per-user inbox: SENT broadcasts this user is in the audience for and
   * has not yet dismissed. Unread state is the absence of a receipt row — no per-user
   * rows are written at publish time.
   *
   * The audience check runs a subquery against broadcast_audience_targets, filtering
   * by the three possible kinds (USER / ROLE / DEPARTMENT). audienceType='all'
   * bypasses the subquery and matches every org member.
   */
  private receiptPredicate(membershipId: number | null | undefined) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    return eq(broadcastReadReceipts.membershipId, membershipId);
  }

  async listInbox(orgId: string, userId: string, limit: number, membershipId?: number | null) {
    const clampedLimit = Math.min(limit, 100);
    const audienceFilter = await this.resolveAudienceFilter(orgId, userId);

    const rows = await this.db
      .select({
        id: broadcasts.id,
        title: broadcasts.title,
        message: broadcasts.message,
        type: broadcasts.type,
        priority: broadcasts.priority,
        category: broadcasts.category,
        channels: broadcasts.channels,
        sentAt: broadcasts.sentAt,
        createdAt: broadcasts.createdAt,
      })
      .from(broadcasts)
      .leftJoin(
        broadcastReadReceipts,
        and(
          eq(broadcastReadReceipts.broadcastId, broadcasts.id),
          eq(broadcastReadReceipts.orgId, orgId),
          this.receiptPredicate(membershipId),
        ),
      )
      .where(
        and(
          eq(broadcasts.orgId, orgId),
          eq(broadcasts.status, "SENT"),
          isNull(broadcastReadReceipts.id),
          audienceFilter,
        ),
      )
      .orderBy(desc(broadcasts.sentAt))
      .limit(clampedLimit);

    return { items: rows };
  }

  async listInboxPage(
    orgId: string,
    userId: string,
    limit: number,
    cursor: InboxSourcePosition | null,
    membershipId?: number | null,
  ) {
    const audienceFilter = await this.resolveAudienceFilter(orgId, userId);

    const rows = await this.db
      .select({
        id: broadcasts.id,
        title: broadcasts.title,
        message: broadcasts.message,
        type: broadcasts.type,
        priority: broadcasts.priority,
        category: broadcasts.category,
        sentAt: broadcasts.sentAt,
        createdAt: broadcasts.createdAt,
      })
      .from(broadcasts)
      .leftJoin(
        broadcastReadReceipts,
        and(
          eq(broadcastReadReceipts.broadcastId, broadcasts.id),
          eq(broadcastReadReceipts.orgId, orgId),
          this.receiptPredicate(membershipId),
        ),
      )
      .where(
        and(
          eq(broadcasts.orgId, orgId),
          eq(broadcasts.status, "SENT"),
          isNull(broadcastReadReceipts.id),
          audienceFilter,
          broadcastInboxKeyset(cursor),
        ),
      )
      .orderBy(desc(broadcastOrderTime()), desc(broadcasts.id))
      .limit(limit);

    return rows;
  }

  /**
   * C21-02. How many org members have dismissed (seen) this broadcast. The count is
   * the number of receipt rows — O(1) with the (org_id, broadcast_id) index.
   */
  async viewerCount(orgId: string, broadcastId: number) {
    await this.findOne(orgId, broadcastId);
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(broadcastReadReceipts)
      .where(
        and(
          eq(broadcastReadReceipts.orgId, orgId),
          eq(broadcastReadReceipts.broadcastId, broadcastId),
        ),
      );
    return { broadcastId, viewerCount: Number(result?.count ?? 0) };
  }

  async cancel(orgId: string, id: number, userId: string) {
    const broadcast = await this.findOne(orgId, id);
    if (!["DRAFT", "SCHEDULED"].includes(broadcast.status)) {
      throw new BadRequestException("Only DRAFT or SCHEDULED broadcasts can be cancelled");
    }
    const [cancelled] = await this.db
      .update(broadcasts)
      .set({ status: "CANCELLED" })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)))
      .returning();
    await this.invalidateCache(orgId);

    this.audit.log({
      action: "notification.broadcast.cancelled",
      userId,
      orgId,
      targetId: String(id),
      targetType: "broadcast",
      metadata: { previousStatus: broadcast.status, title: broadcast.title },
    });

    return cancelled;
  }

  async remove(orgId: string, id: number, userId: string) {
    const broadcast = await this.findOne(orgId, id);
    if (broadcast.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT broadcasts can be deleted");
    }
    await this.db
      .delete(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)));
    await this.invalidateCache(orgId);

    this.audit.log({
      action: "notification.broadcast.deleted",
      userId,
      orgId,
      targetId: String(id),
      targetType: "broadcast",
      metadata: { title: broadcast.title },
    });

    return { success: true };
  }

  private async invalidateCache(orgId: string) {
    await this.cache.invalidateNamespace(`broadcasts:list:${orgId}`);
  }
}
