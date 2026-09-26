import { and, asc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  kbArticleChunks,
  kbChatConversations,
  kbChatMessages,
  kbIngestionCheckpoints,
  kbPageAttachments,
  kbPages,
  kbSources,
} from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { forEachIdPage } from "../../../common/pagination/keyset-drain";
import type { KbPageWriterService } from "../wiki/kb-page-writer.service";

export type DocumentReindexPort = Pick<
  KbPageWriterService,
  "commitManyPageChanges"
>;

export const DOCUMENT_ERASURE_ID_PAGE = 200;

export interface DocumentSubjectScope {
  readonly orgId: string;
  readonly subjectUserId: string;
  readonly membershipId: number;
}

interface ReindexableDocument {
  id: number;
  contentRevision: number;
  aclRevision: number;
  contentText: string | null;
}

export function subjectAuthoredDocument(
  subjectUserId: string,
  membershipId: number,
): SQL {
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

export async function eraseSubjectDocumentDerivatives(
  tx: TenantTx,
  { orgId, subjectUserId, membershipId }: DocumentSubjectScope,
  writer: DocumentReindexPort,
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
  let drainedDocuments: ReindexableDocument[] = [];

  markChunks(
    await forEachIdPage(
      DOCUMENT_ERASURE_ID_PAGE,
      async (cursor) => {
        const rows = await tx
          .select({
            id: kbPages.id,
            contentRevision: kbPages.contentRevision,
            aclRevision: kbPages.aclRevision,
            contentText: kbPages.contentText,
          })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, orgId),
              subjectAuthoredDocument(subjectUserId, membershipId),
              ...(cursor === null ? [] : [gt(kbPages.id, cursor)]),
            ),
          )
          .orderBy(asc(kbPages.id))
          .limit(DOCUMENT_ERASURE_ID_PAGE);
        drainedDocuments = rows;
        return rows;
      },
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
        await writer.commitManyPageChanges(tx, {
          orgId,
          pages: drainedDocuments,
        });
        return removed.length;
      },
    ),
  );

  markChunks(
    await forEachIdPage(
      DOCUMENT_ERASURE_ID_PAGE,
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
          .limit(DOCUMENT_ERASURE_ID_PAGE),
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
      DOCUMENT_ERASURE_ID_PAGE,
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
          .limit(DOCUMENT_ERASURE_ID_PAGE),
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
