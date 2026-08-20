import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { chatChannelMembers, chatMessages, chatSavedMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class ChatSavedService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(userId: string, cursor?: number, limit = 30) {
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [eq(chatSavedMessages.userId, userId)];
    if (cursor) {
      conditions.push(lt(chatSavedMessages.id, cursor));
    }

    const rows = await this.db.query.chatSavedMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatSavedMessages.savedAt)],
      limit: safeLimit + 1,
      with: {
        message: {
          with: {
            sender: { columns: { id: true, name: true, image: true } },
            channel: { columns: { id: true, name: true, type: true } },
            attachments: true,
          },
        },
      },
    });

    const hasMore = rows.length > safeLimit;
    if (hasMore) rows.pop();
    return {
      items: rows,
      nextCursor: hasMore ? rows[rows.length - 1]?.id : undefined,
    };
  }

  async save(userId: string, messageId: number) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.isDeleted, false)),
      columns: { id: true, channelId: true, orgId: true },
    });
    if (!message) throw new NotFoundException("Message not found");

    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, message.channelId), eq(chatChannelMembers.userId, userId)),
    });
    if (!membership) throw new ForbiddenException("Access denied");

    await this.db.insert(chatSavedMessages).values({ orgId: message.orgId, userId, messageId }).onConflictDoNothing();
    return { ok: true };
  }

  async unsave(userId: string, messageId: number) {
    await this.db
      .delete(chatSavedMessages)
      .where(and(eq(chatSavedMessages.userId, userId), eq(chatSavedMessages.messageId, messageId)));
    return { ok: true };
  }

  async isSaved(userId: string, messageId: number) {
    const row = await this.db.query.chatSavedMessages.findFirst({
      where: and(eq(chatSavedMessages.userId, userId), eq(chatSavedMessages.messageId, messageId)),
      columns: { id: true },
    });
    return { saved: Boolean(row) };
  }
}
