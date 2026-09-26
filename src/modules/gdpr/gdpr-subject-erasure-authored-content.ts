import { and, asc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  aiChatConversations,
  aiChatMessages,
  chatMessages,
  kbArticleChunks,
  kbChatConversations,
  kbChatMessages,
  kbIngestionCheckpoints,
  kbPageAttachments,
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

async function clearCheckpointsFor(
  tx: TenantTx,
  orgId: string,
  contentTypes: string[],
  contentIds: number[],
): Promise<number> {
  const removed = await tx
    .delete(kbIngestionCheckpoints)
    .where(
      and(
        eq(kbIngestionCheckpoints.orgId, orgId),
        inArray(kbIngestionCheckpoints.contentType, contentTypes),
        inArray(kbIngestionCheckpoints.contentId, contentIds),
      ),
    )
    .returning({ id: kbIngestionCheckpoints.id });
  return removed.length;
}

export function subjectAuthoredPage(subjectUserId: string, membershipId: number): SQL {
  return (
    or(
      eq(kbPages.createdById, subjectUserId),
      eq(kbPages.ownerUserId, subjectUserId),
      eq(kbPages.lastEditedById, subjectUserId),
      eq(kbPages.createdByMembershipId, membershipId),
      eq(kbPages.ownerMembershipId, membershipId),
      eq(kbPages.lastEditedByMembershipId, membershipId),
    ) ?? sql`false`
  );
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
        sql`EXISTS (SELECT 1 FROM kb_pages p WHERE p.id = ${kbArticleChunks.pageId} AND p.org_id = ${kbArticleChunks.orgId} AND p.created_by_id = ${subjectUserId})`,
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
          .select({ id: kbPages.id })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, orgId),
              subjectAuthoredPage(subjectUserId, membershipId),
              ...(cursor === null ? [] : [gt(kbPages.id, cursor)]),
            ),
          )
          .orderBy(asc(kbPages.id))
          .limit(ERASURE_ID_PAGE),
      async (ids) => {
        const removed = await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              inArray(kbArticleChunks.pageId, ids),
            ),
          )
          .returning({ id: kbArticleChunks.id });
        checkpointsRemoved += await clearCheckpointsFor(
          tx,
          orgId,
          ["page", "article"],
          ids,
        );
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
          .select({ id: kbPageAttachments.id })
          .from(kbPageAttachments)
          .where(
            and(
              eq(kbPageAttachments.orgId, orgId),
              eq(kbPageAttachments.uploadedById, subjectUserId),
              ...(cursor === null ? [] : [gt(kbPageAttachments.id, cursor)]),
            ),
          )
          .orderBy(asc(kbPageAttachments.id))
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
        checkpointsRemoved += await clearCheckpointsFor(
          tx,
          orgId,
          ["attachment"],
          ids,
        );
        return removed.length;
      },
    ),
  );

  if (checkpointsRemoved > 0) tables.push("kb_ingestion_checkpoints");

  return tables;
}
