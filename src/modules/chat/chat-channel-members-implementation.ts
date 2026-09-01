import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
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
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { AblyService } from "../realtime/ably.service";
import { randomUUID } from "node:crypto";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { REALTIME_TOKEN_REVOCATION_EVENT } from "../realtime/realtime-token-revocation";

@Injectable()
export class ChatChannelMembersImplementation {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly entities: EntityReferenceService,
    private readonly ably: AblyService,
  ) {}

  private async resolveMembership(orgId: string, userId: string): Promise<number> {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership) throw new ForbiddenException("User is not an active organization member");
    return membership.id;
  }

  private async assertMember(
    channelId: number,
    userId: string,
    orgId: string,
  ): Promise<{ membershipId: number; role: string }> {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { id: true, isPrivate: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    const membershipId = await this.resolveMembership(orgId, userId);
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, membershipId),
      ),
      columns: { role: true },
    });
    if (!member) {
      if (channel.isPrivate) throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }
    return { membershipId, role: member.role };
  }

  async assertChannelMembership(channelId: number, userId: string, orgId: string): Promise<void> {
    await this.assertMember(channelId, userId, orgId);
  }

  private async assertAdmin(channelId: number, userId: string, orgId: string): Promise<number> {
    const { membershipId, role } = await this.assertMember(channelId, userId, orgId);
    if (role !== "ADMIN") throw new ForbiddenException("Only channel admins can perform this action");
    return membershipId;
  }

  async getChannel(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId, orgId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      with: {
        members: {
          with: {
            membership: {
              columns: { id: true, userId: true },
              with: { user: { columns: { id: true, name: true, image: true, email: true } } },
            },
          },
        },
      },
    });

    return channel ?? null;
  }

  async listMembers(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId, orgId);

    return this.db.query.chatChannelMembers.findMany({
      where: and(eq(chatChannelMembers.orgId, orgId), eq(chatChannelMembers.channelId, channelId)),
      limit: 100,
      with: {
        membership: {
          columns: { id: true, userId: true },
          with: { user: { columns: { id: true, name: true, image: true, email: true } } },
        },
      },
    });
  }

  async addMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) {
    await this.assertAdmin(channelId, requesterId, orgId);

    await assertUsersInOrg(this.db, orgId, [targetUserId]);
    const targetMembershipId = await this.resolveMembership(orgId, targetUserId);

    const existing = await this.db.query.chatChannelMembers.findFirst({
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
    });

    return { ok: true };
  }

  async removeMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) {
    const { role } = await this.assertMember(channelId, requesterId, orgId);

    if (requesterId !== targetUserId && role !== "ADMIN")
      throw new ForbiddenException("Only channel admins can remove other members");

    const targetMembershipId = await this.resolveMembership(orgId, targetUserId);
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
    const membershipId = await this.resolveMembership(orgId, userId);
    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, membershipId),
      ),
      columns: { role: true },
    });

    if (!membership) throw new ForbiddenException("You are not a member of this channel");
    if (membership.role !== "ADMIN")
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
    const actorMembershipId = await this.resolveMembership(actor.orgId, actor.userId);

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
    });

    return { ok: true };
  }

  async leaveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await this.assertMember(channelId, userId, orgId);

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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt: new Date() })
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
    const latestMessage = await this.db
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.channelId, channelId), eq(chatMessages.isDeleted, false)))
      .orderBy(desc(chatMessages.createdAt))
      .limit(1)
      .then((rows) => rows[0]);

    const lastReadAt = latestMessage?.createdAt
      ? new Date(new Date(latestMessage.createdAt).getTime() - 1)
      : new Date(0);

    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt })
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    const { membershipId } = await this.assertMember(channelId, userId, orgId);
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
    await this.assertMember(channelId, userId, orgId);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    const rows = await this.db
      .select({
        id: chatAttachments.id,
        messageId: chatAttachments.messageId,
        fileName: chatAttachments.fileName,
        fileUrl: chatAttachments.fileUrl,
        fileSize: chatAttachments.fileSize,
        mimeType: chatAttachments.mimeType,
        createdAt: chatAttachments.createdAt,
      })
      .from(chatAttachments)
      .innerJoin(chatMessages, eq(chatAttachments.messageId, chatMessages.id))
      .where(
        cursor !== undefined
          ? and(
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.channelId, channelId),
              eq(chatMessages.isDeleted, false),
              lt(chatAttachments.id, cursor),
            )
          : and(
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
    const requesterMembershipId = await this.resolveMembership(orgId, requesterId);
    const requester = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, requesterMembershipId),
      ),
      columns: { role: true },
    });
    if (!requester || requester.role !== "ADMIN") throw new ForbiddenException("Only admins can change roles");

    const targetMembershipId = await this.resolveMembership(orgId, targetUserId);
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
