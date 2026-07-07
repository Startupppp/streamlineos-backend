import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { aiChatMessages, type AiChatRole } from "../../../db/schema";

const MAX_PAGE = 100;

export interface ChatHistoryMessage {
  id: number;
  role: AiChatRole;
  content: string;
  createdAt: string;
}

export interface ChatHistoryPage {
  messages: ChatHistoryMessage[];
  nextCursor: number | null;
}

@Injectable()
export class ChatHistoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async append(orgId: string, userId: string, role: AiChatRole, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    await this.db.insert(aiChatMessages).values({ orgId, userId, role, content: trimmed });
  }

  async list(
    orgId: string,
    userId: string,
    opts: { cursor?: number; limit: number },
  ): Promise<ChatHistoryPage> {
    const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);
    const rows = await this.db
      .select({
        id: aiChatMessages.id,
        role: aiChatMessages.role,
        content: aiChatMessages.content,
        createdAt: aiChatMessages.createdAt,
      })
      .from(aiChatMessages)
      .where(
        and(
          eq(aiChatMessages.orgId, orgId),
          eq(aiChatMessages.userId, userId),
          opts.cursor ? lt(aiChatMessages.id, opts.cursor) : undefined,
        ),
      )
      .orderBy(desc(aiChatMessages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? last.id : null;

    return {
      messages: page.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async clear(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(aiChatMessages)
      .where(and(eq(aiChatMessages.orgId, orgId), eq(aiChatMessages.userId, userId)));
  }
}
