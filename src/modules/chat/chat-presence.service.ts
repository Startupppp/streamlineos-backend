import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, ilike, sql } from "drizzle-orm";
import {
  chatChannelMembers,
  chatMessages,
  chatUserPresence,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import type { StatusInput } from "./dto/chat.schemas";

const PRESENCE_WINDOW_MS = 90 * 1000;

@Injectable()
export class ChatPresenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  async heartbeat(userId: string, orgId: string) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    await this.db
      .insert(chatUserPresence)
      .values({ userId, orgId, membershipId, status: "ONLINE", lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [chatUserPresence.orgId, chatUserPresence.userId],
        set: { status: "ONLINE", lastSeenAt: new Date() },
      });

    return { ok: true };
  }

  getOnlineUsers(orgId: string) {
    const cutoff = new Date(Date.now() - PRESENCE_WINDOW_MS);

    return this.db
      .select({
        userId: chatUserPresence.userId,
        status: chatUserPresence.status,
        lastSeenAt: chatUserPresence.lastSeenAt,
        userName: users.name,
        userImage: users.image,
      })
      .from(chatUserPresence)
      .innerJoin(users, eq(chatUserPresence.userId, users.id))
      .where(and(eq(chatUserPresence.orgId, orgId), gt(chatUserPresence.lastSeenAt, cutoff)));
  }

  async setStatus(userId: string, orgId: string, body: StatusInput) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    await this.db
      .insert(chatUserPresence)
      .values({ userId, orgId, membershipId, status: body.status, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [chatUserPresence.orgId, chatUserPresence.userId],
        set: { status: body.status, lastSeenAt: new Date() },
      });

    return { ok: true };
  }

  async getUnreadTotal(userId: string): Promise<number> {
    try {
      const [row] = await this.db
        .select({ total: count() })
        .from(chatChannelMembers)
        .innerJoin(
          chatMessages,
          and(
            eq(chatMessages.channelId, chatChannelMembers.channelId),
            gt(chatMessages.createdAt, chatChannelMembers.lastReadAt),
            eq(chatMessages.isDeleted, false),
          ),
        )
        .where(eq(chatChannelMembers.userId, userId));

      return row?.total ?? 0;
    } catch (error) {
      logger.error("[chat.getUnreadTotal]", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return 0;
    }
  }

  async searchMessages(userId: string, orgId: string, query: string, channelId: number | undefined, limit: number) {
    const safeQuery = query.replace(/[%_\\]/g, "\\$&");
    const conditions = [
      eq(chatMessages.orgId, orgId),
      ilike(chatMessages.content, `%${safeQuery}%`),
      eq(chatMessages.isDeleted, false),
      sql`EXISTS (SELECT 1 FROM ${chatChannelMembers} m
                  WHERE m.channel_id = ${chatMessages.channelId}
                    AND m.org_id = ${orgId}
                    AND m.user_id = ${userId})`,
    ];

    if (channelId) conditions.push(eq(chatMessages.channelId, channelId));

    return this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.createdAt)],
      limit: Math.min(limit, 50),
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        channel: { columns: { id: true, name: true, type: true } },
      },
    });
  }

  getOrgUsers(orgId: string) {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        role: organizationMembers.role,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(eq(users.isActive, true), eq(organizationMembers.orgId, orgId)),
      );
  }
}
