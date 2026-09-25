import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbArticleChunks } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";

type ChunkFamily = SQL | undefined;

export interface KbDerivedChunkState {
  contentHash: string | null;
  aclRevision: number | null;
  chunkCount: number;
}

/** Chunks holding one article attachment's extracted text. */
export function attachmentChunks(
  orgId: string,
  attachmentId: number,
): ChunkFamily {
  return and(
    eq(kbArticleChunks.orgId, orgId),
    eq(kbArticleChunks.attachmentId, attachmentId),
    eq(kbArticleChunks.source, "attachment"),
  );
}

/** Chunks holding one `kb_sources` row's note or file text. */
export function sourceChunks(orgId: string, sourceId: number): ChunkFamily {
  return and(
    eq(kbArticleChunks.orgId, orgId),
    eq(kbArticleChunks.sourceId, sourceId),
    eq(kbArticleChunks.source, "source"),
  );
}

/** Chunks holding the document attached to one wiki page. */
export function pageDocumentChunks(orgId: string, pageId: number): ChunkFamily {
  return and(
    eq(kbArticleChunks.orgId, orgId),
    eq(kbArticleChunks.pageId, pageId),
    eq(kbArticleChunks.source, "attachment"),
    isNull(kbArticleChunks.attachmentId),
  );
}

export async function loadDerivedChunkState(
  db: Db,
  where: ChunkFamily,
): Promise<KbDerivedChunkState> {
  const [row] = await db
    .select({
      contentHash: sql<string | null>`min(${kbArticleChunks.contentHash})`,
      aclRevision: sql<number | null>`min(${kbArticleChunks.aclRevision})`,
      chunkCount: sql<number>`count(*)::int`,
    })
    .from(kbArticleChunks)
    .where(where);

  return {
    contentHash: row?.contentHash ?? null,
    aclRevision: row?.aclRevision ?? null,
    chunkCount: row?.chunkCount ?? 0,
  };
}

export async function updateDerivedChunkAcl(
  db: Db,
  where: ChunkFamily,
  aclRevision: number,
): Promise<void> {
  await db.update(kbArticleChunks).set({ aclRevision, aclSyncedAt: new Date() }).where(where);
}

/** The columns every derived chunk row shares, so the three writers cannot drift apart. */
function derivedChunkRow(
  chunk: string,
  embedding: number[],
  index: number,
  contentHash: string,
) {
  return {
    source: "attachment" as const,
    chunkIndex: index,
    content: chunk,
    contentHash,
    tokens: Math.ceil(chunk.length / 4),
    embedding,
    embeddingModel: EMBEDDING_MODEL,
  };
}

export async function replaceSourceChunks(
  db: Db,
  orgId: string,
  sourceId: number,
  chunks: string[],
  embeddings: number[][],
  contentHash: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(kbArticleChunks).where(sourceChunks(orgId, sourceId));
    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        pageId: null,
        attachmentId: null,
        sourceId,
        ...derivedChunkRow(chunk, embeddings[index], index, contentHash),
        source: "source" as const,
      })),
    );
  });
}

export async function replaceAttachmentChunks(
  db: Db,
  orgId: string,
  attachmentId: number,
  pageId: number | null,
  chunks: string[],
  embeddings: number[][],
  meta: { contentHash: string; aclRevision: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(kbArticleChunks)
      .where(attachmentChunks(orgId, attachmentId));
    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        pageId,
        attachmentId,
        ...derivedChunkRow(chunk, embeddings[index], index, meta.contentHash),
        aclRevision: meta.aclRevision,
        aclSyncedAt: new Date(),
      })),
    );
  });
}

export async function replacePageDocumentChunks(
  db: Db,
  orgId: string,
  pageId: number,
  chunks: string[],
  embeddings: number[][],
  meta: {
    contentHash: string;
    pageVisibility: string;
    pageProjectId: number | null;
    pageCreatedById: string | null;
    pageCreatedByMembershipId: number | null;
    aclRevision: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(kbArticleChunks).where(pageDocumentChunks(orgId, pageId));
    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        pageId,
        attachmentId: null,
        ...derivedChunkRow(chunk, embeddings[index], index, meta.contentHash),
        pageVisibility: meta.pageVisibility,
        pageProjectId: meta.pageProjectId,
        pageCreatedById: meta.pageCreatedById,
        pageCreatedByMembershipId: meta.pageCreatedByMembershipId,
        aclRevision: meta.aclRevision,
        aclSyncedAt: new Date(),
      })),
    );
  });
}
