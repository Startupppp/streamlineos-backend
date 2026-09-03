import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbArticleChunks } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";

/** What `and(...)` yields. Drizzle's `.where()` accepts the undefined arm, so no force is needed. */
type ChunkFamily = SQL | undefined;

/**
 * The skip-if-unchanged state for the chunk families that are NOT a body.
 *
 * `kb-chunk-repository.ts` covers the two body families (`article_body`, `page_body`): each
 * carries a `content_hash` and is short-circuited on it. The three derived families —
 * attachment text, wiki-source text, page-document text — carried neither a hash nor an
 * `acl_revision`, so every call re-embedded byte-identical input and re-charged for it, and
 * the rows took the `acl_revision` column default of 1 while `articleVectorCandidates` joins
 * `kb_article_chunks.acl_revision = kb_articles.acl_revision` with `=`.
 *
 * These helpers give the derived families the same two facts the body families have: what
 * text the stored vectors were made from, and which ACL revision they were captured at.
 */
export interface KbDerivedChunkState {
  contentHash: string | null;
  aclRevision: number | null;
  chunkCount: number;
}

/** Chunks holding one article attachment's extracted text. */
export function attachmentChunks(orgId: string, attachmentId: number): ChunkFamily {
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
  );
}

/**
 * One aggregate rather than a row fetch: every chunk in a family is written by a single
 * statement, so `min()` reports the family's hash and revision and `count(*)` says whether
 * there is a family at all. `chunkCount` is what the caller reports when it short-circuits.
 *
 * `db` is the tenant-aware handle, which routes to the ambient transaction. Every caller of
 * these three families runs inside one — the outbox consumer and the after-commit hook each
 * open their own — and the family predicate names `org_id` itself regardless.
 */
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

/**
 * Moves a family's ACL revision without re-embedding, the way `updateArticleChunkRevisions`
 * does for a body. The text has not changed, so the vectors are still correct; only the value
 * the candidate join equates has moved.
 */
export async function updateDerivedChunkAcl(
  db: Db,
  where: ChunkFamily,
  aclRevision: number,
): Promise<void> {
  await db.update(kbArticleChunks).set({ aclRevision }).where(where);
}

/** The columns every derived chunk row shares, so the three writers cannot drift apart. */
function derivedChunkRow(chunk: string, embedding: number[], index: number, contentHash: string) {
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

/**
 * Delete-then-insert in ONE transaction, for all three families.
 *
 * The delete is scoped by the family predicate rather than by id alone, so a page that holds
 * both a body and a document keeps its body chunks. `contentHash` and `aclRevision` are what
 * the two defects here were about, so they are written by these functions and nowhere else.
 */
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
        articleId: null,
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
  articleId: number | null,
  chunks: string[],
  embeddings: number[][],
  meta: { contentHash: string; aclRevision: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(kbArticleChunks).where(attachmentChunks(orgId, attachmentId));
    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        articleId,
        pageId: null,
        attachmentId,
        ...derivedChunkRow(chunk, embeddings[index], index, meta.contentHash),
        aclRevision: meta.aclRevision,
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
        articleId: null,
        pageId,
        attachmentId: null,
        ...derivedChunkRow(chunk, embeddings[index], index, meta.contentHash),
        pageVisibility: meta.pageVisibility,
        pageProjectId: meta.pageProjectId,
        pageCreatedById: meta.pageCreatedById,
        pageCreatedByMembershipId: meta.pageCreatedByMembershipId,
        aclRevision: meta.aclRevision,
      })),
    );
  });
}
