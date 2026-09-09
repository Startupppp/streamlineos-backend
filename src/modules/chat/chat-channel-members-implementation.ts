import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  chatAttachments,
  chatChannelMembers,
  chatChannels,
  chatMessages,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { UpdateChannelInput } from "./dto/chat.schemas";
import { assertUsersInOrg } from "../../common/tenant/org-membership";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { AblyService } from "../realtime/ably.service";
import { randomUUID } from "node:crypto";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertChannelAdmin,
  assertChannelMember,
  resolveOrgMembership,
} from "./chat-channel-authorization";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { REALTIME_TOKEN_REVOCATION_EVENT } from "../realtime/realtime-token-revocation";
import {
  CHANNEL_MEMBER_COLUMNS,
  CHANNEL_MEMBER_MEMBERSHIP_WITH,
  flattenChannelMember,
} from "./chat-channel-member-shape";

@Injectable()
export class ChatChannelMembersImplementation {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly entities: EntityReferenceService,
    private readonly ably: AblyService,
  ) {}

  async assertChannelMembership(channelId: number, userId: string, orgId: string): Promise<void> {
    await assertChannelMember(this.db, channelId, userId, orgId);
  }

  private channelHighWaterMark(channelId: number, orgId: string) {
    return sql<number>`COALESCE((SELECT ${chatChannels.messageCount} FROM ${chatChannels} WHERE ${chatChannels.id} = ${channelId} AND ${chatChannels.orgId} = ${orgId}), 0)`;
  }

  async getChannel(channelId: number, userId: string, orgId: string) {
    await assertChannelMember(this.db, channelId, userId, orgId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      with: {
        members: {
          columns: CHANNEL_MEMBER_COLUMNS,
          with: { membership: CHANNEL_MEMBER_MEMBERSHIP_WITH },
        },
      },
    });

    if (!channel) return null;
    return { ...channel, members: channel.members.map(flattenChannelMember) };
  }

  async listMembers(channelId: number, userId: string, orgId: string, cursor?: number, limit?: number) {
    await assertChannelMember(this.db, channelId, userId, orgId);

    const PAGE_SIZE = Math.min(limit ?? 50, PAGE_SIZE_CAP);

    const rows = await this.db.query.chatChannelMembers.findMany({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        cursor !== undefined ? gt(chatChannelMembers.id, cursor) : undefined,
      ),
      orderBy: [asc(chatChannelMembers.id)],
      limit: PAGE_SIZE + 1,
      columns: CHANNEL_MEMBER_COLUMNS,
      with: { membership: CHANNEL_MEMBER_MEMBERSHIP_WITH },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const pageSlice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? (pageSlice[pageSlice.length - 1]?.id ?? null) : null;
    return { members: pageSlice.map(flattenChannelMember), nextCursor };
  }

  async addMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) {
    await assertChannelAdmin(this.db, channelId, requesterId, orgId);

    await assertUsersInOrg(this.db, orgId, [targetUserId]);
    const targetMembershipId = await resolveOrgMembership(this.db, orgId, targetUserId);

    const existing = await this.db.query.chatChannelMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, targetMembershipId),
      ),
    });

    if (existing) throw new ConflictException("User is already a member of this channel");

    await this.db.insert(chatChannelMembers).values({
      orgId,
      channelId,
      membershipId: targetMembershipId,
      role: "MEMBER",
      lastReadPosition: this.channelHighWaterMark(channelId, orgId),
    });

    return { ok: true };
  }

  async removeMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) {
    const { role } = await assertChannelMember(this.db, channelId, requesterId, orgId);

    if (requesterId !== targetUserId && role !== "ADMIN")
      throw new ForbiddenException("Only channel admins can remove other members");

    const targetMembershipId = await resolveOrgMembership(this.db, orgId, targetUserId);
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.delete(chatChannelMembers).where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.channelId, channelId),
            eq(chatChannelMembers.membershipId, targetMembershipId),
          ),
        );
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "realtime.token-revocation",
          aggregateId: `${channelId}:${targetMembershipId}:${randomUUID()}`,
          aggregateVersion: 1,
          eventType: REALTIME_TOKEN_REVOCATION_EVENT,
          payload: { orgId, userId: targetUserId, channelId, membershipId: targetMembershipId },
          occurredAt: new Date(),
        });
      },
      { orgId },
    );

    return { ok: true };
  }

  async updateChannel(channelId: number, userId: string, body: UpdateChannelInput, orgId: string) {
    const { role } = await assertChannelMember(this.db, channelId, userId, orgId);
    if (role !== "ADMIN")
      throw new ForbiddenException("Only channel admins can update channel details");

    const updateData: Partial<typeof chatChannels.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.avatarUrl !== undefined) updateData.avatarUrl = body.avatarUrl;

    await this.db
      .update(chatChannels)
      .set(updateData)
      .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)));

    return { ok: true };
  }

  async joinOpenChannel(channelId: number, actor: EntityActor) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, actor.orgId),
        eq(chatChannels.isArchived, false),
      ),
      columns: { id: true, type: true, entityType: true, entityId: true },
    });

    if (!channel) throw new NotFoundException("Channel not found");
    const actorMembershipId = await resolveOrgMembership(this.db, actor.orgId, actor.userId);

    if (channel.type !== "PUBLIC") {
      if (!channel.entityType || !channel.entityId)
        throw new NotFoundException("Channel not found");
      const [resolution] = await this.entities.resolve(actor, [
        { type: channel.entityType, id: channel.entityId },
      ]);
      if (resolution?.status !== "resolved")
        throw new NotFoundException("Channel not found");
    }

    const existing = await this.db.query.chatChannelMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(chatChannelMembers.orgId, actor.orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, actorMembershipId),
      ),
    });

    if (existing) return { ok: true };

    await this.db.insert(chatChannelMembers).values({
      orgId: actor.orgId,
      channelId,
      membershipId: actorMembershipId,
      role: "MEMBER",
      lastReadPosition: this.channelHighWaterMark(channelId, actor.orgId),
    });

    return { ok: true };
  }

  async leaveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.delete(chatChannelMembers).where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.channelId, channelId),
            eq(chatChannelMembers.membershipId, membershipId),
          ),
        );
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "realtime.token-revocation",
          aggregateId: `${channelId}:${membershipId}:${randomUUID()}`,
          aggregateVersion: 1,
          eventType: REALTIME_TOKEN_REVOCATION_EVENT,
          payload: { orgId, userId, channelId, membershipId },
          occurredAt: new Date(),
        });
      },
      { orgId },
    );

    return { ok: true };
  }

  async archiveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async unarchiveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ archivedAt: null })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async markRead(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    // GREATEST, not assignment: two marks in flight together commit in either order,
    // and a plain write lets the older one rewind the cursor and resurrect read messages.
    const readAt = new Date().toISOString();
    const highWaterMark = this.channelHighWaterMark(channelId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({
        lastReadAt: sql`GREATEST(${chatChannelMembers.lastReadAt}, ${readAt}::timestamp)`,
        lastReadPosition: sql`GREATEST(${chatChannelMembers.lastReadPosition}, ${highWaterMark})`,
      })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );

    await this.cache.invalidateNamespace(`chat:unread:${orgId}`);

    return { ok: true };
  }

  async markChannelUnread(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    const latestMessage = await this.db
      .select({ channelPosition: chatMessages.channelPosition, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.channelId, channelId), eq(chatMessages.isDeleted, false)))
      .orderBy(desc(chatMessages.channelPosition))
      .limit(1)
      .then((rows) => rows[0]);

    const lastReadPosition = latestMessage
      ? Math.max(latestMessage.channelPosition - 1, 0)
      : 0;
    const lastReadAt = latestMessage?.createdAt
      ? new Date(new Date(latestMessage.createdAt).getTime() - 1)
      : new Date(0);

    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt, lastReadPosition })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );

    return { ok: true };
  }

  async muteChannel(channelId: number, userId: string, duration: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    const until =
      duration === "forever"
        ? new Date("2099-12-31")
        : duration === "24h"
          ? new Date(Date.now() + 86400_000)
          : duration === "8h"
            ? new Date(Date.now() + 28800_000)
            : duration === "1h"
              ? new Date(Date.now() + 3600_000)
              : new Date(Date.now() + 900_000);
    await this.db
      .update(chatChannelMembers)
      .set({ mutedUntil: until })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true, mutedUntil: until };
  }

  async unmuteChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ mutedUntil: null })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async favoriteChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ isFavorite: true })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async unfavoriteChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ isFavorite: false })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async setNotificationPreference(channelId: number, userId: string, preference: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ notificationPreference: preference })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true, notificationPreference: preference };
  }

  async listChannelFiles(channelId: number, userId: string, orgId: string, cursor?: number, limit = 20) {
    await assertChannelMember(this.db, channelId, userId, orgId);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    const rows = await this.db
      .select({
        id: chatAttachments.id,
        messageId: chatAttachments.messageId,
        fileName: chatAttachments.fileName,
        fileKey: chatAttachments.fileKey,
        fileSize: chatAttachments.fileSize,
        mimeType: chatAttachments.mimeType,
        createdAt: chatAttachments.createdAt,
      })
      .from(chatAttachments)
      .innerJoin(chatMessages, eq(chatAttachments.messageId, chatMessages.id))
      .where(
        cursor !== undefined
          ? and(
              eq(chatAttachments.orgId, orgId),
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.channelId, channelId),
              eq(chatMessages.isDeleted, false),
              lt(chatAttachments.id, cursor),
            )
          : and(
              eq(chatAttachments.orgId, orgId),
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.channelId, channelId),
              eq(chatMessages.isDeleted, false),
            ),
      )
      .orderBy(desc(chatAttachments.id))
      .limit(safeLimit + 1);

    const hasMore = rows.length > safeLimit;
    if (hasMore) rows.pop();
    return { files: rows, nextCursor: hasMore ? rows[rows.length - 1]?.id : undefined };
  }

  async updateMemberRole(channelId: number, targetUserId: string, requesterId: string, orgId: string, role: string) {
    const { role: requesterRole } = await assertChannelMember(this.db, channelId, requesterId, orgId);
    if (requesterRole !== "ADMIN") throw new ForbiddenException("Only admins can change roles");

    const targetMembershipId = await resolveOrgMembership(this.db, orgId, targetUserId);
    if (!targetMembershipId) return { ok: true };

    await this.db.update(chatChannelMembers).set({ role }).where(
      and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, targetMembershipId),
      ),
    );
    return { ok: true };
  }
}
