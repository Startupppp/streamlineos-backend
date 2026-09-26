import { and, eq } from "drizzle-orm";
import { kbArticleChunks } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";

export interface KbPageChunkState {
  contentHash: string | null;
}

export function pageBodyChunks(orgId: string, pageId: number) {
  return and(
    eq(kbArticleChunks.pageId, pageId),
    eq(kbArticleChunks.orgId, orgId),
    eq(kbArticleChunks.source, "page_body"),
  );
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
      })
      .from(kbArticleChunks)
      .where(pageBodyChunks(orgId, pageId))
      .limit(1),
  { orgId });

  return existing ?? null;
}

export async function replacePageBodyChunks(
  db: Db,
  orgId: string,
  pageId: number,
  chunks: string[],
  embeddings: number[][],
  meta: { contentHash: string; contentRevision: number },
  clearCheckpoints: (tx: TenantTx) => Promise<void>,
): Promise<void> {
  await runInTenantTransaction(db, async (tx) => {
    await tx
      .delete(kbArticleChunks)
      .where(pageBodyChunks(orgId, pageId));

    await tx.insert(kbArticleChunks).values(
      chunks.map((chunk, index) => ({
        orgId,
        pageId,
        attachmentId: null,
        source: "page_body" as const,
        chunkIndex: index,
        content: chunk,
        contentHash: meta.contentHash,
        tokens: estimateTokens(chunk),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
        contentRevision: meta.contentRevision,
      })),
    );

    await clearCheckpoints(tx);
  }, { orgId });
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
