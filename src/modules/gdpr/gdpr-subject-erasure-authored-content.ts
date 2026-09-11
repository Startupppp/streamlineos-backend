import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  aiChatConversations,
  aiChatMessages,
  chatMessages,
  kbArticleAttachments,
  kbArticleChunks,
  kbArticles,
  kbChatConversations,
  kbChatMessages,
  kbIngestionCheckpoints,
  kbPages,
  kbSources,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { ERASURE_ID_PAGE, forEachIdPage } from "./gdpr-subject-erasure-paging";

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

async function clearCheckpoints(
  tx: TenantTx,
  orgId: string,
  contentType: "article" | "page",
  contentIds: number[],
): Promise<number> {
  const removed = await tx
    .delete(kbIngestionCheckpoints)
    .where(
      and(
        eq(kbIngestionCheckpoints.orgId, orgId),
        eq(kbIngestionCheckpoints.contentType, contentType),
        inArray(kbIngestionCheckpoints.contentId, contentIds),
      ),
    )
    .returning({ id: kbIngestionCheckpoints.id });
  return removed.length;
}

/**
 * Knowledge-base derivatives are a verbatim reproduction of the subject's text — the
 * chunk body and its embedding both carry it — so they are hard-deleted rather than
 * redacted, everywhere the subject authored the source page, article, attachment or
 * uploaded document. Owner ids are keyset-drained so a subject past one page is still
 * fully erased.
 */
export async function eraseSubjectKbContent(
  tx: TenantTx,
  { orgId, subjectUserId, membershipId }: AuthoredContentScope,
): Promise<string[]> {
  const tables: string[] = [];

  const kbMsgResult = await tx
    .delete(kbChatMessages)
    .where(
      and(
        eq(kbChatMessages.orgId, orgId),
        eq(kbChatMessages.userMembershipId, membershipId),
      ),
    )
    .returning({ id: kbChatMessages.id });
  if (kbMsgResult.length > 0) tables.push("kb_chat_messages");

  const kbConvResult = await tx
    .delete(kbChatConversations)
    .where(
      and(
        eq(kbChatConversations.orgId, orgId),
        eq(kbChatConversations.userMembershipId, membershipId),
      ),
    )
    .returning({ id: kbChatConversations.id });
  if (kbConvResult.length > 0) tables.push("kb_chat_conversations");

  const pageChunkResult = await tx
    .delete(kbArticleChunks)
    .where(
      and(
        eq(kbArticleChunks.orgId, orgId),
        eq(kbArticleChunks.pageCreatedById, subjectUserId),
      ),
    )
    .returning({ id: kbArticleChunks.id });
  if (pageChunkResult.length > 0) tables.push("kb_article_chunks");

  const markChunks = (deletedCount: number) => {
    if (deletedCount > 0 && !tables.includes("kb_article_chunks"))
      tables.push("kb_article_chunks");
  };

  let checkpointsRemoved = 0;

  markChunks(
    await forEachIdPage(
      ERASURE_ID_PAGE,
      (cursor) =>
        tx
          .select({ id: kbArticles.id })
          .from(kbArticles)
          .where(
            and(
              eq(kbArticles.orgId, orgId),
              eq(kbArticles.authorId, subjectUserId),
              ...(cursor === null ? [] : [gt(kbArticles.id, cursor)]),
            ),
          )
          .orderBy(asc(kbArticles.id))
          .limit(ERASURE_ID_PAGE),
      async (ids) => {
        const removed = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.articleId, ids),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        checkpointsRemoved += await clearCheckpoints(tx, orgId, "article", ids);
        return removed.length;
      },
    ),
  );

  markChunks(
    await forEachIdPage(
      ERASURE_ID_PAGE,
      (cursor) =>
        tx
          .select({ id: kbSources.id })
          .from(kbSources)
          .where(
            and(
              eq(kbSources.orgId, orgId),
              eq(kbSources.createdById, subjectUserId),
              ...(cursor === null ? [] : [gt(kbSources.id, cursor)]),
            ),
          )
          .orderBy(asc(kbSources.id))
          .limit(ERASURE_ID_PAGE),
      async (ids) => {
        const removed = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.sourceId, ids),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        return removed.length;
      },
    ),
  );

  markChunks(
    await forEachIdPage(
      ERASURE_ID_PAGE,
      (cursor) =>
        tx
          .select({ id: kbArticleAttachments.id })
          .from(kbArticleAttachments)
          .where(
            and(
              eq(kbArticleAttachments.orgId, orgId),
              eq(kbArticleAttachments.uploadedBy, subjectUserId),
              ...(cursor === null ? [] : [gt(kbArticleAttachments.id, cursor)]),
            ),
          )
          .orderBy(asc(kbArticleAttachments.id))
          .limit(ERASURE_ID_PAGE),
      async (ids) => {
        const removed = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.attachmentId, ids),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        return removed.length;
      },
    ),
  );

  // kb_ingestion_checkpoints keeps the chunk text and its embedding for content whose
  // indexing was interrupted. It survives the chunk delete because it is keyed by
  // (content_type, content_id), not by a foreign key to the chunk row.
  checkpointsRemoved += await forEachIdPage(
    ERASURE_ID_PAGE,
    (cursor) =>
      tx
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.createdById, subjectUserId),
            ...(cursor === null ? [] : [gt(kbPages.id, cursor)]),
          ),
        )
        .orderBy(asc(kbPages.id))
        .limit(ERASURE_ID_PAGE),
    (ids) => clearCheckpoints(tx, orgId, "page", ids),
  );

  if (checkpointsRemoved > 0) tables.push("kb_ingestion_checkpoints");

  return tables;
}
