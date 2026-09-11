import { and, eq } from "drizzle-orm";
import { kbArticleChunks } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";

export interface KbArticleChunkState {
  contentHash: string | null;
  aclRevision: number | null;
  contentRevision: number | null;
}

export interface KbPageChunkState {
  contentHash: string | null;
  pageVisibility: string | null;
  pageProjectId: number | null;
  pageCreatedById: string | null;
  pageCreatedByMembershipId: number | null;
  aclRevision: number | null;
}

export interface KbChunkRevisions {
  aclRevision: number;
  contentRevision: number;
}

export interface KbPageChunkAcl {
  pageVisibility: string;
  pageProjectId: number | null;
  pageCreatedById: string | null;
  pageCreatedByMembershipId: number | null;
  aclRevision: number;
}

export function articleBodyChunks(orgId: string, articleId: number) {
  return and(
    eq(kbArticleChunks.orgId, orgId),
    eq(kbArticleChunks.articleId, articleId),
    eq(kbArticleChunks.source, "article_body"),
  );
}

export function pageBodyChunks(orgId: string, pageId: number) {
  return and(
    eq(kbArticleChunks.pageId, pageId),
    eq(kbArticleChunks.orgId, orgId),
    eq(kbArticleChunks.source, "page_body"),
  );
}

export async function loadArticleChunkState(
  db: Db,
  orgId: string,
  articleId: number,
): Promise<KbArticleChunkState | null> {
  const [existing] = await runInTenantTransaction(db, async (tx) =>
    tx
      .select({
        contentHash: kbArticleChunks.contentHash,
        aclRevision: kbArticleChunks.aclRevision,
        contentRevision: kbArticleChunks.contentRevision,
      })
      .from(kbArticleChunks)
      .where(articleBodyChunks(orgId, articleId))
      .limit(1),
  { orgId });

  return existing ?? null;
}

export async function loadPageChunkState(
  db: Db,
  orgId: string,
  pageId: number,
): Promise<KbPageChunkState | null> {
  const [existing] = await runInTenantTransaction(db, async (tx) =>
    tx
      .select({
        contentHash: kbArticleChunks.contentHash,
        pageVisibility: kbArticleChunks.pageVisibility,
        pageProjectId: kbArticleChunks.pageProjectId,
        pageCreatedById: kbArticleChunks.pageCreatedById,
        pageCreatedByMembershipId: kbArticleChunks.pageCreatedByMembershipId,
        aclRevision: kbArticleChunks.aclRevision,
      })
      .from(kbArticleChunks)
      .where(pageBodyChunks(orgId, pageId))
      .limit(1),
  { orgId });

  return existing ?? null;
}

export async function updateArticleChunkRevisions(
  db: Db,
  orgId: string,
  articleId: number,
  revisions: KbChunkRevisions,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) =>
    tx
      .update(kbArticleChunks)
      .set(revisions)
      .where(articleBodyChunks(orgId, articleId)),
  { orgId });
}

export async function updatePageChunkAcl(
  db: Db,
  orgId: string,
  pageId: number,
  acl: KbPageChunkAcl,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) =>
    tx
      .update(kbArticleChunks)
      .set(acl)
      .where(pageBodyChunks(orgId, pageId)),
  { orgId });
}

export async function replaceArticleBodyChunks(
  db: Db,
  orgId: string,
  articleId: number,
  chunks: string[],
  embeddings: number[][],
  meta: KbChunkRevisions & { contentHash: string },
  clearCheckpoints: (tx: TenantTx) => Promise<void>,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) => {
    await tx
      .delete(kbArticleChunks)
      .where(articleBodyChunks(orgId, articleId));

    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        articleId,
        pageId: null,
        attachmentId: null,
        source: "article_body" as const,
        chunkIndex: index,
        content: chunk,
        contentHash: meta.contentHash,
        tokens: estimateTokens(chunk),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
        contentRevision: meta.contentRevision,
        aclRevision: meta.aclRevision,
      })),
    );

    await clearCheckpoints(tx);
  }, { orgId });
}

export async function replacePageBodyChunks(
  db: Db,
  orgId: string,
  pageId: number,
  chunks: string[],
  embeddings: number[][],
  meta: KbPageChunkAcl & { contentHash: string; contentRevision: number },
  clearCheckpoints: (tx: TenantTx) => Promise<void>,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) => {
    await tx
      .delete(kbArticleChunks)
      .where(pageBodyChunks(orgId, pageId));

    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        articleId: null,
        pageId,
        attachmentId: null,
        source: "page_body" as const,
        chunkIndex: index,
        content: chunk,
        contentHash: meta.contentHash,
        tokens: estimateTokens(chunk),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
        pageVisibility: meta.pageVisibility,
        pageProjectId: meta.pageProjectId,
        pageCreatedById: meta.pageCreatedById,
        pageCreatedByMembershipId: meta.pageCreatedByMembershipId,
        aclRevision: meta.aclRevision,
        contentRevision: meta.contentRevision,
      })),
    );

    await clearCheckpoints(tx);
  }, { orgId });
}

export async function deleteArticleChunks(
  db: Db,
  orgId: string,
  articleId: number,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) =>
    tx
      .delete(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.articleId, articleId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      ),
  { orgId });
}

export async function deletePageChunks(
  db: Db,
  orgId: string,
  pageId: number,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) =>
    tx
      .delete(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.pageId, pageId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      ),
  { orgId });
}

function estimateTokens(chunk: string): number {
  return Math.ceil(chunk.length / 4);
}
