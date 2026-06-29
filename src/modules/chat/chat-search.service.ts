import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessages, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class ChatSearchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async searchMessages(orgId: string, userId: string, query: string, limit = 20, cursor?: number, from?: string, to?: string, sender?: string) {
    if (!query.trim()) return { results: [], nextCursor: undefined };
    const q = `%${query.trim()}%`;

    const memberChannels = await this.db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));

    const memberChannelIds = memberChannels.map(m => m.channelId);
    if (memberChannelIds.length === 0) return { results: [], nextCursor: undefined };

    const conditions = [
      sql`${chatMessages.channelId} = ANY(ARRAY[${sql.join(memberChannelIds.map(id => sql`${id}`), sql`, `)}]::int[])`,
      ilike(chatMessages.content, q),
      eq(chatMessages.isDeleted, false),
    ];
    if (cursor) conditions.push(sql`${chatMessages.id} < ${cursor}`);
    if (from) conditions.push(gte(chatMessages.createdAt, new Date(from)));
    if (to) conditions.push(lte(chatMessages.createdAt, new Date(to)));
    if (sender) conditions.push(eq(chatMessages.senderId, sender));

    const rows = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.createdAt)],
      limit: limit + 1,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        channel: { columns: { id: true, name: true, type: true } },
      },
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { results: rows, nextCursor: hasMore ? rows[rows.length - 1]?.id : undefined };
  }

  async searchChannels(orgId: string, userId: string, query: string) {
    if (!query.trim()) return [];
    const q = `%${query.trim()}%`;

    const memberChannels = await this.db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));

    const memberChannelIds = new Set(memberChannels.map(m => m.channelId));

    const channels = await this.db.query.chatChannels.findMany({
      where: and(
        eq(chatChannels.orgId, orgId),
        ilike(chatChannels.name, q),
      ),
      columns: { id: true, name: true, type: true, description: true, avatarUrl: true },
      limit: 10,
    });

    return channels.map(c => ({ ...c, isMember: memberChannelIds.has(c.id) }));
  }

  async searchUsers(orgId: string, query: string) {
    if (!query.trim()) return [];
    const q = `%${query.trim()}%`;
    return this.db.query.users.findMany({
      where: or(ilike(users.name, q), ilike(users.email, q)),
      columns: { id: true, name: true, email: true, image: true },
      limit: 10,
    });
  }
}
