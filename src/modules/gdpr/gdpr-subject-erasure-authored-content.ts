import { and, eq } from "drizzle-orm";
import {
  aiChatConversations,
  aiChatMessages,
  chatMessages,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";

export const ERASED_CONTENT = "[ERASED]";

export interface AuthoredContentScope {
  readonly orgId: string;
  readonly subjectUserId: string;
  readonly membershipId: number;
}

export interface ConversationErasure {
  readonly tables: string[];
  /**
   * Every chat message the redaction touched. `chat_attachments` has no foreign key to
   * `users` and hangs off these ids alone, so the attachment sink is driven from here
   * rather than from a second read of `chat_messages`.
   */
  readonly chatMessageIds: number[];
}

/**
 * Conversation text the subject wrote inside shared threads. The rows carry other
 * participants' context, so the body is redacted in place rather than deleted.
 */
export async function anonymiseSubjectConversations(
  tx: TenantTx,
  { orgId, subjectUserId, membershipId }: AuthoredContentScope,
): Promise<ConversationErasure> {
  const tables: string[] = [];

  const aiConvResult = await tx
    .update(aiChatConversations)
    .set({ title: ERASED_CONTENT })
    .where(
      and(
        eq(aiChatConversations.orgId, orgId),
        eq(aiChatConversations.userId, subjectUserId),
      ),
    )
    .returning({ id: aiChatConversations.id });
  if (aiConvResult.length > 0) tables.push("ai_chat_conversations");

  const aiMsgResult = await tx
    .update(aiChatMessages)
    .set({ content: ERASED_CONTENT })
    .where(
      and(
        eq(aiChatMessages.orgId, orgId),
        eq(aiChatMessages.userId, subjectUserId),
      ),
    )
    .returning({ id: aiChatMessages.id });
  if (aiMsgResult.length > 0) tables.push("ai_chat_messages");

  const chatMsgResult = await tx
    .update(chatMessages)
    .set({ content: ERASED_CONTENT })
    .where(
      and(
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.senderMembershipId, membershipId),
      ),
    )
    .returning({ id: chatMessages.id });
  if (chatMsgResult.length > 0) tables.push("chat_messages");

  return { tables, chatMessageIds: chatMsgResult.map((row) => row.id) };
}
