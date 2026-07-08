import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, desc, lt, inArray } from "drizzle-orm";
import { broadcasts, notifications, userMemberships, userRoles, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { CreateBroadcastInput, UpdateBroadcastInput, ListBroadcastsInput } from "./dto/broadcast.schemas";

@Injectable()
export class BroadcastsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string, filters: ListBroadcastsInput) {
    const key = `broadcasts:list:${orgId}:${JSON.stringify(filters)}`;
    return this.cache.cached(
      key,
      () => this.queryBroadcasts(orgId, filters),
      CACHE_TTL.SHORT,
    );
  }

  private async queryBroadcasts(orgId: string, filters: ListBroadcastsInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const rows = await this.db
      .select()
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.orgId, orgId),
          filters.status ? eq(broadcasts.status, filters.status) : undefined,
          filters.cursor ? lt(broadcasts.id, filters.cursor) : undefined,
        ),
      )
      .orderBy(desc(broadcasts.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
    };
  }

  async findOne(orgId: string, id: number) {
    const broadcast = await this.db.query.broadcasts.findFirst({
      where: and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)),
    });
    if (!broadcast) throw new NotFoundException(`Broadcast ${id} not found`);
    return broadcast;
  }

  async create(orgId: string, userId: string, dto: CreateBroadcastInput) {
    const [created] = await this.db
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
        status: "DRAFT",
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        createdBy: userId,
      })
      .returning();
    await this.invalidateCache(orgId);
    return created;
  }

  async update(orgId: string, _userId: string, id: number, dto: UpdateBroadcastInput) {
    const existing = await this.findOne(orgId, id);
    if (existing.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT broadcasts can be updated");
    }
    const [updated] = await this.db
      .update(broadcasts)
      .set({
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.message !== undefined && { message: dto.message }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.channels !== undefined && { channels: dto.channels }),
        ...(dto.audience !== undefined && { audience: dto.audience }),
        ...(dto.scheduledAt !== undefined && { scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null }),
      })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)))
      .returning();
    await this.invalidateCache(orgId);
    return updated;
  }

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

    const recipientUserIds = await this.resolveRecipients(orgId, broadcast.audience);

    const now = new Date();
    if (recipientUserIds.length > 0 && broadcast.channels.includes("IN_APP")) {
      const notifValues = recipientUserIds.map((uid) => ({
        orgId,
        userId: uid,
        type: broadcast.type,
        priority: broadcast.priority,
        category: broadcast.category,
        title: broadcast.title,
        message: broadcast.message,
        channel: "IN_APP",
        sourceModule: "BROADCAST",
        metadata: { broadcastId: id } as Record<string, unknown>,
      }));

      const batchSize = 100;
      for (let i = 0; i < notifValues.length; i += batchSize) {
        await this.db.insert(notifications).values(notifValues.slice(i, i + batchSize));
      }
    }

    const [sent] = await this.db
      .update(broadcasts)
      .set({
        status: "SENT",
        sentAt: now,
        recipientCount: recipientUserIds.length,
        deliveredCount: broadcast.channels.includes("IN_APP") ? recipientUserIds.length : 0,
      })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)))
      .returning();

    await this.invalidateCache(orgId);
    return sent;
  }

  async cancel(orgId: string, _userId: string, id: number) {
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
    return cancelled;
  }

  async remove(orgId: string, _userId: string, id: number) {
    const broadcast = await this.findOne(orgId, id);
    if (broadcast.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT broadcasts can be deleted");
    }
    await this.db
      .delete(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)));
    await this.invalidateCache(orgId);
    return { success: true };
  }

  private async resolveRecipients(
    orgId: string,
    audience: { type: string; roleIds?: string[]; departmentIds?: string[]; userIds?: string[] },
  ): Promise<string[]> {
    const dedupe = (ids: string[]): string[] => [...new Set(ids.filter(Boolean))];

    if (audience.type === "users") {
      const ids = dedupe(audience.userIds ?? []);
      if (ids.length === 0) return [];
      const rows = await this.db
        .select({ userId: userMemberships.userId })
        .from(userMemberships)
        .where(and(eq(userMemberships.orgId, orgId), inArray(userMemberships.userId, ids)));
      return dedupe(rows.map((r) => r.userId));
    }

    if (audience.type === "roles") {
      const roleIds = (audience.roleIds ?? []).map(Number).filter((n) => Number.isInteger(n));
      if (roleIds.length === 0) return [];
      const rows = await this.db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.roleId, roleIds)));
      return dedupe(rows.map((r) => r.userId));
    }

    if (audience.type === "departments") {
      const deptIds = (audience.departmentIds ?? []).map(Number).filter((n) => Number.isInteger(n));
      if (deptIds.length === 0) return [];
      const rows = await this.db
        .select({ userId: userMemberships.userId })
        .from(userMemberships)
        .innerJoin(users, eq(users.id, userMemberships.userId))
        .where(and(eq(userMemberships.orgId, orgId), inArray(users.departmentId, deptIds)));
      return dedupe(rows.map((r) => r.userId));
    }

    const memberships = await this.db
      .select({ userId: userMemberships.userId })
      .from(userMemberships)
      .where(eq(userMemberships.orgId, orgId));
    return dedupe(memberships.map((m) => m.userId));
  }

  private async invalidateCache(orgId: string) {
    await this.cache.del(`broadcasts:list:${orgId}`);
  }
}
