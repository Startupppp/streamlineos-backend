import { NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { aiChatConversations, aiChatMessages, type AiChatRole } from "../../../../db/schema";

export const MAX_PAGE = 100;

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

export async function listConversationMessages(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
  conversationId: number,
  opts: { cursor?: number; limit: number },
): Promise<ChatHistoryPage> {
  const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);

  const [conv] = await db
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

  const rows = await db
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

/**
 * `conversationId` comes straight off the request body, so the conversation is
 * resolved against the caller's tenant AND membership BEFORE anything is
 * written.
 *
 * Every statement here used to key on the bare `id`. A forged id therefore
 * inserted the caller's message into a stranger's conversation and then rewrote
 * that conversation's title with the first 60 characters of the caller's
 * prompt — a cross-tenant write, and the read-back that followed handed a
 * foreign title to whoever asked next. Ownership is checked once, up front, and
 * every subsequent statement still carries the org predicate, because a guard
 * that lives only in the preceding SELECT is one refactor away from being gone.
 */
export async function appendMessageToConversation(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
  conversationId: number,
  role: AiChatRole,
  content: string,
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  const owned = and(
    eq(aiChatConversations.id, conversationId),
    eq(aiChatConversations.orgId, orgId),
  );

  const [conv] = await db
    .select({ title: aiChatConversations.title })
    .from(aiChatConversations)
    .where(
      and(owned, eq(aiChatConversations.userMembershipId, membershipId)),
    )
    .limit(1);

  if (!conv) throw new NotFoundException("Conversation not found");

  await db.insert(aiChatMessages).values({ orgId, userId, userMembershipId: membershipId, role, content: trimmed, conversationId });

  const now = new Date();

  if (conv.title === null && role === "user") {
    await db
      .update(aiChatConversations)
      .set({ title: trimmed.substring(0, 60).trim(), updatedAt: now })
      .where(owned);
  } else {
    await db
      .update(aiChatConversations)
      .set({ updatedAt: now })
      .where(owned);
  }
}
