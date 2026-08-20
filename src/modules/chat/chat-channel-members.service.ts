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
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { UpdateChannelInput } from "./dto/chat.schemas";
import { assertUsersInOrg } from "../../common/tenant/org-membership";


@Injectable()
export class ChatChannelMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private async assertMember(channelId: number, userId: string) {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    return member;
  }

  private async assertAdmin(channelId: number, userId: string) {
    const member = await this.assertMember(channelId, userId);
    if (member.role !== "ADMIN") throw new ForbiddenException("Only channel admins can perform this action");
    return member;
  }

  async getChannel(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      with: {
        members: {
          with: {
            user: { columns: { id: true, name: true, image: true, email: true } },
          },
        },
      },
    });

    return channel ?? null;
  }

  async listMembers(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);

    return this.db.query.chatChannelMembers.findMany({
      where: eq(chatChannelMembers.channelId, channelId),
      limit: 100,
      with: {
        user: {
          columns: { id: true, name: true, image: true, email: true },
        },
      },
    });
  }

  async addMember(channelId: number, targetUserId: string, requesterId: string) {
    await this.assertAdmin(channelId, requesterId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      columns: { orgId: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    await assertUsersInOrg(this.db, channel.orgId, [targetUserId]);

    const existing = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, targetUserId),
      ),
    });

    if (existing) throw new ConflictException("User is already a member of this channel");

    await this.db.insert(chatChannelMembers).values({
      orgId: channel.orgId,
      channelId,
      userId: targetUserId,
      role: "MEMBER",
    });

    return { ok: true };
  }

  async removeMember(channelId: number, targetUserId: string, requesterId: string) {
    const requester = await this.assertMember(channelId, requesterId);

    if (requesterId !== targetUserId && requester.role !== "ADMIN") {
      throw new ForbiddenException("Only channel admins can remove other members");
    }

    await this.db
      .delete(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, targetUserId),
        ),
      );

    return { ok: true };
  }

  async updateChannel(channelId: number, userId: string, body: UpdateChannelInput, orgId: string) {
    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });

    if (!membership) throw new ForbiddenException("You are not a member of this channel");
    if (membership.role !== "ADMIN") {
      throw new ForbiddenException("Only channel admins can update channel details");
    }

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

  async joinPublicChannel(channelId: number, userId: string, orgId: string) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, orgId),
        eq(chatChannels.type, "PUBLIC"),
        eq(chatChannels.isArchived, false),
      ),
    });

    if (!channel) throw new NotFoundException("Public channel not found");

    const existing = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });

    if (existing) return { ok: true };

    await this.db.insert(chatChannelMembers).values({
      orgId,
      channelId,
      userId,
      role: "MEMBER",
    });

    return { ok: true };
  }

  async leaveChannel(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);

    await this.db
      .delete(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );

    return { ok: true };
  }

  async archiveChannel(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);
    await this.db
      .update(chatChannelMembers)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true };
  }

  async unarchiveChannel(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);
    await this.db
      .update(chatChannelMembers)
      .set({ archivedAt: null })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true };
  }

  async markRead(channelId: number, userId: string, orgId: string) {
    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );

    await this.cache.invalidateNamespace(`chat:unread:${orgId}`);

    return { ok: true };
  }

  async markChannelUnread(channelId: number, userId: string) {
    const latestMessage = await this.db
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(eq(chatMessages.channelId, channelId), eq(chatMessages.isDeleted, false)))
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
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );

    return { ok: true };
  }

  async muteChannel(channelId: number, userId: string, duration: string) {
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
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true, mutedUntil: until };
  }

  async unmuteChannel(channelId: number, userId: string) {
    await this.db
      .update(chatChannelMembers)
      .set({ mutedUntil: null })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true };
  }

  async favoriteChannel(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);
    await this.db
      .update(chatChannelMembers)
      .set({ isFavorite: true })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true };
  }

  async unfavoriteChannel(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);
    await this.db
      .update(chatChannelMembers)
      .set({ isFavorite: false })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true };
  }

  async setNotificationPreference(channelId: number, userId: string, preference: string) {
    await this.assertMember(channelId, userId);
    await this.db
      .update(chatChannelMembers)
      .set({ notificationPreference: preference })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );
    return { ok: true, notificationPreference: preference };
  }

  async listChannelFiles(channelId: number, userId: string, cursor?: number, limit = 20) {
    await this.assertMember(channelId, userId);
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
              eq(chatMessages.channelId, channelId),
              eq(chatMessages.isDeleted, false),
              lt(chatAttachments.id, cursor),
            )
          : and(
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

  async updateMemberRole(channelId: number, targetUserId: string, requesterId: string, role: string) {
    const requester = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, requesterId)),
    });
    if (!requester || requester.role !== "ADMIN") throw new ForbiddenException("Only admins can change roles");
    await this.db.update(chatChannelMembers)
      .set({ role })
      .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, targetUserId)));
    return { ok: true };
  }
}
