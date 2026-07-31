import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessages,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { CacheService } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import type { CreateChannelInput } from "./dto/chat.schemas";
import { assertUsersInOrg } from "../../common/tenant/org-membership";
import {
  isStaleEntityChannelName,
  resolveEntityChannelName,
} from "./entity-channel-name.util";

const chatUnreadKey = (userId: string, orgId: string) => `chat:unread:${userId}:${orgId}`;

@Injectable()
export class ChatChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly cache: CacheService,
  ) {}

  private async ensureEntityChannelDisplayName<
    T extends {
      id: number;
      name: string;
      entityType: string | null;
      entityId: string | null;
    },
  >(channel: T, orgId: string): Promise<T> {
    if (!channel.entityType || !channel.entityId) return channel;

    const resolved = await resolveEntityChannelName(
      this.db,
      channel.entityType,
      channel.entityId,
      orgId,
    );
    if (!resolved || channel.name === resolved) return channel;
    if (!isStaleEntityChannelName(channel.name, channel.entityType, channel.entityId)) {
      return channel;
    }

    await this.db
      .update(chatChannels)
      .set({ name: resolved })
      .where(eq(chatChannels.id, channel.id));

    return { ...channel, name: resolved };
  }

  async getMyChannels(userId: string, orgId: string) {
    return this.listMemberChannels(userId, orgId, false);
  }

  async getArchivedChannels(userId: string, orgId: string) {
    return this.listMemberChannels(userId, orgId, true);
  }

  private async listMemberChannels(userId: string, orgId: string, archived: boolean) {
    try {
      const memberships = await this.db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.userId, userId),
            archived ? isNotNull(chatChannelMembers.archivedAt) : isNull(chatChannelMembers.archivedAt),
          ),
        );

      if (memberships.length === 0) return [];

      const channelIds = memberships.map((m) => m.channelId);

      const channels = await this.db.query.chatChannels.findMany({
        where: and(
          eq(chatChannels.orgId, orgId),
          inArray(chatChannels.id, channelIds),
          eq(chatChannels.isArchived, false),
        ),
        orderBy: [desc(chatChannels.lastMessageAt)],
        limit: 100,
        with: {
          members: {
            with: { user: { columns: { id: true, name: true, image: true } } },
          },
        },
      });

      const unreadRows = await this.cache.cached(
        chatUnreadKey(userId, orgId),
        () =>
          this.db
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
                eq(chatMessages.isDeleted, false),
                gt(chatMessages.createdAt, chatChannelMembers.lastReadAt),
              ),
            )
            .groupBy(chatMessages.channelId),
        15,
      );

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

      const enrichedChannels = await Promise.all(
        channels.map((ch) => this.ensureEntityChannelDisplayName(ch, orgId)),
      );

      return enrichedChannels.map((ch) => ({
        ...ch,
        unreadCount: unreadMap.get(ch.id) ?? 0,
        lastMessage: lastMsgMap.get(ch.id) ?? null,
      }));
    } catch (error) {
      logger.error(archived ? "[chat.getArchivedChannels]" : "[chat.getMyChannels]", {
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
      limit: 100,
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

  async createChannel(orgId: string, userId: string, body: CreateChannelInput) {
    if (body.type === "DIRECT") {
      const { targetUserId } = body;
      await assertUsersInOrg(this.db, orgId, [targetUserId]);

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

    if (!entityType) {
      await this.planLimits.assertWithinLimit(orgId, "chatChannels");
    }

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
      return this.ensureEntityChannelDisplayName(existing, orgId);
    }

    const resolvedName = await resolveEntityChannelName(
      this.db,
      entityType,
      entityId,
      orgId,
    );
    const fallbackName = `${entityType.charAt(0).toUpperCase() + entityType.slice(1)}: ${entityId}`;

    const channel = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatChannels)
        .values({
          orgId,
          name: resolvedName ?? fallbackName,
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
}
