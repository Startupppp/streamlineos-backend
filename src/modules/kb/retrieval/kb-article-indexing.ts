import type { Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { sha256, chunkText } from "./kb-chunk-utils";
import { embedChunksWithResumption } from "./kb-embedding-resumption";
import {
  deleteArticleChunks,
  loadArticleChunkState,
  replaceArticleBodyChunks,
  updateArticleChunkRevisions,
} from "./kb-chunk-repository";

/** Published-article indexing: eligibility, revision-only refresh, resumable embedding and replacement. */
export async function indexArticleContent(
  dependencies: { db: Db; aiGateway: AiGatewayService; checkpoint: KbIngestionCheckpointService; logger: Logger },
  orgId: string,
  articleId: number,
  signal?: AbortSignal,
): Promise<void> {
  const { db, aiGateway, checkpoint, logger } = dependencies;
  const article = await runInTenantTransaction(db, async (tx) =>
    tx.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { status: true, contentText: true, contentRevision: true, aclRevision: true },
    }),
  { orgId });

  if (!article || article.status !== "published" || !article.contentText?.trim() || !aiGateway.isEmbeddingConfigured()) {
    await deleteArticleChunks(db, orgId, articleId);
    return;
  }

  const chunks = chunkText(article.contentText);
  const contentHash = sha256(article.contentText);
  if (chunks.length === 0) {
    await deleteArticleChunks(db, orgId, articleId);
    return;
  }

  const stored = await loadArticleChunkState(db, orgId, articleId);
  const contentRevision = article.contentRevision;
  const aclRevision = article.aclRevision;

  // An unchanged body must not strand a new ACL revision: candidate queries
  // require the indexed and source ACL revisions to match before disclosure.
  if (stored?.contentHash === contentHash) {
    if (stored.aclRevision === aclRevision && stored.contentRevision === contentRevision) return;
    logger.log("KB article ACL updated (content unchanged)", { orgId, articleId });
    await updateArticleChunkRevisions(db, orgId, articleId, { aclRevision, contentRevision });
    return;
  }

  logger.log("KB article indexing started", { orgId, articleId, chunks: chunks.length });
  const embeddings = await embedChunksWithResumption(
    { aiGateway, checkpoint, logger },
    { orgId, contentType: "article", contentId: articleId, contentHash, chunks, signal },
  );
  await replaceArticleBodyChunks(
    db, orgId, articleId, chunks, embeddings, { contentHash, contentRevision, aclRevision },
    (tx) => checkpoint.clearCheckpoints(tx, orgId, "article", articleId),
  );
  logger.log("KB article indexing committed", { orgId, articleId, chunks: chunks.length });
}
