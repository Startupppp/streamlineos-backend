import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { aiChatConversations, aiChatMessages, type AiChatRole } from "../../../../db/schema";
import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
} from "./lib/ai-conversations";

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

  async append(orgId: string, userId: string, membershipId: number, role: AiChatRole, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    await this.db.insert(aiChatMessages).values({ orgId, userId, userMembershipId: membershipId, role, content: trimmed });
  }

  async list(
    orgId: string,
    userId: string,
    membershipId: number,
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
          eq(aiChatMessages.userMembershipId, membershipId),
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

  async clear(orgId: string, userId: string, membershipId: number): Promise<void> {
    await this.db
      .delete(aiChatMessages)
      .where(and(eq(aiChatMessages.orgId, orgId), eq(aiChatMessages.userMembershipId, membershipId)));
  }

  /** @see lib/ai-conversations.ts */
  async listConversations(
    orgId: string,
    userId: string,
    membershipId: number,
    opts: { cursor?: number; limit: number },
  ): Promise<AiConversationListPage> {
    return listConversations(this.db, orgId, userId, membershipId, opts);
  }

  /** @see lib/ai-conversations.ts */
  async createConversation(
    orgId: string,
    userId: string,
    membershipId: number,
    title?: string,
  ): Promise<AiConversation> {
    return createConversation(this.db, orgId, userId, membershipId, title);
  }

  /** @see lib/ai-conversations.ts */
  async renameConversation(
    orgId: string,
    userId: string,
    membershipId: number,
    id: number,
    title: string,
  ): Promise<AiConversation> {
    return renameConversation(this.db, orgId, userId, membershipId, id, title);
  }

  /** @see lib/ai-conversations.ts */
  async deleteConversation(
    orgId: string,
    userId: string,
    membershipId: number,
    id: number,
  ): Promise<void> {
    return deleteConversation(this.db, orgId, userId, membershipId, id);
  }

  async listMessages(
    orgId: string,
    userId: string,
    membershipId: number,
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
          eq(aiChatConversations.userMembershipId, membershipId),
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
    membershipId: number,
    conversationId: number,
    role: AiChatRole,
    content: string,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    await this.db.insert(aiChatMessages).values({ orgId, userId, userMembershipId: membershipId, role, content: trimmed, conversationId });

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
