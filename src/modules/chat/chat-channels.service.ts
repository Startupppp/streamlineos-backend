import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import {
  chatAttachments,
  chatChannels,
  chatChannelMembers,
  chatMessages,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import type { CreateChannelInput, UpdateChannelInput } from "./dto/chat.schemas";

@Injectable()
export class ChatChannelsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  async getMyChannels(userId: string, orgId: string) {
    try {
      const memberships = await this.db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(eq(chatChannelMembers.userId, userId));

      if (memberships.length === 0) return [];

      const channelIds = memberships.map((m) => m.channelId);

      const channels = await this.db.query.chatChannels.findMany({
        where: and(
          eq(chatChannels.orgId, orgId),
          inArray(chatChannels.id, channelIds),
          eq(chatChannels.isArchived, false),
        ),
        orderBy: [desc(chatChannels.lastMessageAt)],
        with: {
          members: {
            with: { user: { columns: { id: true, name: true, image: true } } },
          },
        },
      });

      const unreadRows = await this.db
        .select({ channelId: chatMessages.channelId, count: count() })
        .from(chatMessages)
        .innerJoin(
          chatChannelMembers,
          and(
            eq(chatChannelMembers.channelId, chatMessages.channelId),
            eq(chatChannelMembers.userId, userId),
          ),
        )
        .where(
          and(
            inArray(chatMessages.channelId, channelIds),
            ne(chatMessages.senderId, userId),
            eq(chatMessages.isDeleted, false),
            gt(chatMessages.createdAt, chatChannelMembers.lastReadAt),
          ),
        )
        .groupBy(chatMessages.channelId);

      const unreadMap = new Map(unreadRows.map((r) => [r.channelId, r.count]));

      const lastMessageRows = await this.db
        .selectDistinctOn([chatMessages.channelId], {
          channelId: chatMessages.channelId,
          content: chatMessages.content,
          senderName: users.name,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .leftJoin(users, eq(users.id, chatMessages.senderId))
        .where(
          and(inArray(chatMessages.channelId, channelIds), eq(chatMessages.isDeleted, false)),
        )
        .orderBy(chatMessages.channelId, desc(chatMessages.createdAt));

      const lastMsgMap = new Map(
        lastMessageRows.map((r) => [
          r.channelId,
          { content: r.content, senderName: r.senderName, createdAt: r.createdAt },
        ]),
      );

      return channels.map((ch) => ({
        ...ch,
        unreadCount: unreadMap.get(ch.id) ?? 0,
        lastMessage: lastMsgMap.get(ch.id) ?? null,
      }));
    } catch (error) {
      logger.error("[chat.getMyChannels]", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return [];
    }
  }

  async listPublicChannels(orgId: string, userId: string) {
    const publicChannels = await this.db.query.chatChannels.findMany({
      where: and(
        eq(chatChannels.orgId, orgId),
        eq(chatChannels.type, "PUBLIC"),
        eq(chatChannels.isArchived, false),
      ),
      orderBy: [desc(chatChannels.lastMessageAt)],
      with: {
        members: {
          columns: { userId: true },
        },
      },
    });

    return publicChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      description: ch.description,
      avatarUrl: ch.avatarUrl,
      type: ch.type,
      memberCount: ch.members.length,
      isMember: ch.members.some((m) => m.userId === userId),
      createdAt: ch.createdAt,
      lastMessageAt: ch.lastMessageAt,
    }));
  }

  async getChannel(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      with: {
        members: {
          with: {
            user: { columns: { id: true, name: true, image: true, email: true, role: true } },
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
      with: {
        user: {
          columns: { id: true, name: true, image: true, email: true, role: true },
        },
      },
    });
  }

  async createChannel(orgId: string, userId: string, body: CreateChannelInput) {
    if (body.type === "DIRECT") {
      const { targetUserId } = body;

      const myMemberships = await this.db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(eq(chatChannelMembers.userId, userId));

      if (myMemberships.length > 0) {
        const channelIds = myMemberships.map((c) => c.channelId);
        const existingDMs = await this.db.query.chatChannels.findMany({
          where: and(
            inArray(chatChannels.id, channelIds),
            eq(chatChannels.type, "DIRECT"),
            eq(chatChannels.orgId, orgId),
          ),
          with: { members: true },
        });

        const dmChannel = existingDMs.find(
          (ch) => ch.members.length === 2 && ch.members.some((m) => m.userId === targetUserId),
        );

        if (dmChannel) return { channel: dmChannel, created: false };
      }

      const [targetUser, currentUser] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, targetUserId),
          columns: { name: true },
        }),
        this.db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { name: true },
        }),
      ]);

      const channel = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(chatChannels)
          .values({
            orgId,
            name: `${currentUser?.name ?? "User"} & ${targetUser?.name ?? "User"}`,
            type: "DIRECT",
            createdBy: userId,
          })
          .returning();

        await tx.insert(chatChannelMembers).values([
          { channelId: created.id, userId, role: "MEMBER" },
          { channelId: created.id, userId: targetUserId, role: "MEMBER" },
        ]);

        return created;
      });

      return { channel, created: true };
    }

    const { name, description, avatarUrl, memberIds, entityType, entityId } = body;
    const allMembers = [...new Set([userId, ...memberIds])];
    const channelType = body.type;
    const isPrivate = channelType === "PRIVATE";

    const channel = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatChannels)
        .values({
          orgId,
          name,
          type: channelType,
          description,
          avatarUrl,
          createdBy: userId,
          isPrivate,
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
        })
        .returning();

      await tx.insert(chatChannelMembers).values(
        allMembers.map((uid) => ({
          channelId: created.id,
          userId: uid,
          role: uid === userId ? "ADMIN" : "MEMBER",
        })),
      );

      return created;
    });

    return { channel, created: true };
  }

  async joinPublicChannel(channelId: number, userId: string) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
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

  async addMember(channelId: number, targetUserId: string, requesterId: string) {
    await this.assertAdmin(channelId, requesterId);

    const existing = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, targetUserId),
      ),
    });

    if (existing) throw new ConflictException("User is already a member of this channel");

    await this.db.insert(chatChannelMembers).values({
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

  async updateChannel(channelId: number, userId: string, body: UpdateChannelInput) {
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

    await this.db.update(chatChannels).set(updateData).where(eq(chatChannels.id, channelId));

    return { ok: true };
  }

  async archiveChannel(channelId: number, userId: string) {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    });
    if (!member || member.role !== "ADMIN") throw new ForbiddenException("Only admins can archive channels");
    await this.db.update(chatChannels).set({ isArchived: true }).where(eq(chatChannels.id, channelId));
    return { ok: true };
  }

  async unarchiveChannel(channelId: number, userId: string) {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    });
    if (!member || member.role !== "ADMIN") throw new ForbiddenException("Only admins can unarchive channels");
    await this.db.update(chatChannels).set({ isArchived: false }).where(eq(chatChannels.id, channelId));
    return { ok: true };
  }

  async markRead(channelId: number, userId: string) {
    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );

    return { ok: true };
  }

  async markChannelUnread(channelId: number, userId: string) {
    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt: new Date(0) })
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
      );

    return { ok: true };
  }

  async getOrCreateEntityChannel(entityType: string, entityId: string, userId: string, orgId: string) {
    const existing = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        eq(chatChannels.orgId, orgId),
      ),
      with: {
        members: {
          with: { user: { columns: { id: true, name: true, image: true } } },
        },
      },
    });

    if (existing) {
      const isMember = existing.members.some((m) => m.userId === userId);
      if (!isMember) {
        await this.db.insert(chatChannelMembers).values({
          channelId: existing.id,
          userId,
          role: "MEMBER",
        });
      }
      return existing;
    }

    const channel = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatChannels)
        .values({
          orgId,
          name: `${entityType.charAt(0).toUpperCase() + entityType.slice(1)}: ${entityId}`,
          type: "GROUP",
          createdBy: userId,
          entityType,
          entityId,
        })
        .returning();

      await tx.insert(chatChannelMembers).values({
        channelId: created.id,
        userId,
        role: "ADMIN",
      });

      return created;
    });

    return channel;
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
