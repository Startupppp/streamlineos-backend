import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { aiChatConversations, aiChatMessages, type AiChatRole } from "../../../db/schema";

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

export interface AiConversation {
  id: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationListPage {
  conversations: AiConversation[];
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

  async listConversations(
    orgId: string,
    userId: string,
    opts: { cursor?: number; limit: number },
  ): Promise<AiConversationListPage> {
    const limit = Math.min(Math.max(opts.limit, 1), 50);

    let cursorRow: { updatedAt: Date; id: number } | undefined;
    if (opts.cursor) {
      const [found] = await this.db
        .select({ updatedAt: aiChatConversations.updatedAt, id: aiChatConversations.id })
        .from(aiChatConversations)
        .where(eq(aiChatConversations.id, opts.cursor))
        .limit(1);
      cursorRow = found;
    }

    const rows = await this.db
      .select({
        id: aiChatConversations.id,
        title: aiChatConversations.title,
        createdAt: aiChatConversations.createdAt,
        updatedAt: aiChatConversations.updatedAt,
      })
      .from(aiChatConversations)
      .where(
        cursorRow
          ? and(
              eq(aiChatConversations.orgId, orgId),
              eq(aiChatConversations.userId, userId),
              or(
                lt(aiChatConversations.updatedAt, cursorRow.updatedAt),
                and(
                  eq(aiChatConversations.updatedAt, cursorRow.updatedAt),
                  lt(aiChatConversations.id, cursorRow.id),
                ),
              ),
            )
          : and(eq(aiChatConversations.orgId, orgId), eq(aiChatConversations.userId, userId)),
      )
      .orderBy(desc(aiChatConversations.updatedAt), desc(aiChatConversations.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? last.id : null;

    return {
      conversations: page.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async createConversation(orgId: string, userId: string, title?: string): Promise<AiConversation> {
    const rows = await this.db
      .insert(aiChatConversations)
      .values({ orgId, userId, title: title ?? null })
      .returning();
    const conv = rows[0];
    if (!conv) throw new Error("Failed to create conversation");
    return {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    };
  }

  async renameConversation(orgId: string, userId: string, id: number, title: string): Promise<AiConversation> {
    const [existing] = await this.db
      .select({
        id: aiChatConversations.id,
        createdAt: aiChatConversations.createdAt,
      })
      .from(aiChatConversations)
      .where(
        and(
          eq(aiChatConversations.id, id),
          eq(aiChatConversations.orgId, orgId),
          eq(aiChatConversations.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Conversation not found");

    const now = new Date();
    await this.db
      .update(aiChatConversations)
      .set({ title, updatedAt: now })
      .where(eq(aiChatConversations.id, id));

    return {
      id: existing.id,
      title,
      createdAt: existing.createdAt.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  async deleteConversation(orgId: string, userId: string, id: number): Promise<void> {
    const [existing] = await this.db
      .select({ id: aiChatConversations.id })
      .from(aiChatConversations)
      .where(
        and(
          eq(aiChatConversations.id, id),
          eq(aiChatConversations.orgId, orgId),
          eq(aiChatConversations.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Conversation not found");

    await this.db.delete(aiChatConversations).where(eq(aiChatConversations.id, id));
  }

  async listMessages(
    orgId: string,
    userId: string,
    conversationId: number,
    opts: { cursor?: number; limit: number },
  ): Promise<ChatHistoryPage> {
    const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);

    const [conv] = await this.db
      .select({ id: aiChatConversations.id })
      .from(aiChatConversations)
      .where(
        and(
          eq(aiChatConversations.id, conversationId),
          eq(aiChatConversations.orgId, orgId),
          eq(aiChatConversations.userId, userId),
        ),
      )
      .limit(1);

    if (!conv) throw new NotFoundException("Conversation not found");

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
          eq(aiChatMessages.conversationId, conversationId),
          eq(aiChatMessages.orgId, orgId),
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

  async appendToConversation(
    orgId: string,
    userId: string,
    conversationId: number,
    role: AiChatRole,
    content: string,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    await this.db.insert(aiChatMessages).values({ orgId, userId, role, content: trimmed, conversationId });

    const now = new Date();
    const [conv] = await this.db
      .select({ title: aiChatConversations.title })
      .from(aiChatConversations)
      .where(eq(aiChatConversations.id, conversationId))
      .limit(1);

    if (conv && conv.title === null && role === "user") {
      await this.db
        .update(aiChatConversations)
        .set({ title: trimmed.substring(0, 60).trim(), updatedAt: now })
        .where(eq(aiChatConversations.id, conversationId));
    } else {
      await this.db
        .update(aiChatConversations)
        .set({ updatedAt: now })
        .where(eq(aiChatConversations.id, conversationId));
    }
  }
}
