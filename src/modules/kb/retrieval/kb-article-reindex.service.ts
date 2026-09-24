import { Injectable, NotFoundException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import { kbArticleChunks, kbPageAttachments, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { sql } from "drizzle-orm";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { KbIndexingService } from "./kb-indexing.service";
import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";

const REINDEX_BATCH_SIZE = 100;
const REINDEX_CONCURRENCY = 4;

@Injectable()
export class KbArticleReindexService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly indexing: KbIndexingService,
    private readonly attachmentIndexing: KbAttachmentIndexingService,
  ) {}

  async reindexAll(orgId: string, afterArticleId = 0): Promise<{
    total: number;
    indexed: number;
    totalChunks: number;
    failures: { articleId: number; error: string }[];
    nextArticleId: number | null;
  }> {
    const articles = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          supportArticlePredicate(),
          eq(kbPages.status, "published"),
          gt(kbPages.id, afterArticleId),
        ),
      )
      .orderBy(asc(kbPages.id))
      .limit(REINDEX_BATCH_SIZE + 1);

    const batch = articles.slice(0, REINDEX_BATCH_SIZE);
    const nextArticleId = articles.length > REINDEX_BATCH_SIZE ? (batch.at(-1)?.id ?? null) : null;

    const failures: { articleId: number; error: string }[] = [];
    let indexed = 0;
    for (let i = 0; i < batch.length; i += REINDEX_CONCURRENCY) {
      const chunk = batch.slice(i, i + REINDEX_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (article) => {
          try {
            await this.reindexArticle(orgId, article.id);
            return { ok: true as const };
          } catch (err) {
            return {
              ok: false as const,
              articleId: article.id,
              error: err instanceof Error ? err.message : "unknown error",
            };
          }
        }),
      );
      for (const result of results) {
        if (result.ok) indexed += 1;
        else failures.push({ articleId: result.articleId, error: result.error });
      }
    }

    const [row] = await this.db
      .select({ chunks: count() })
      .from(kbArticleChunks)
      .where(eq(kbArticleChunks.orgId, orgId));

    return { total: batch.length, indexed, totalChunks: row?.chunks ?? 0, failures, nextArticleId };
  }

  async reindexArticle(
    orgId: string,
    articleId: number,
  ): Promise<{ chunks: number; warnings: string[] }> {
    await this.assertArticleExists(orgId, articleId);

    await this.indexing.indexArticle(orgId, articleId);

    const attachments = await this.db.query.kbPageAttachments.findMany({
      where: and(
        eq(kbPageAttachments.pageId, articleId),
        eq(kbPageAttachments.orgId, orgId),
        isNull(kbPageAttachments.deletedAt),
      ),
      columns: { id: true },
    });

    const warnings: string[] = [];
    for (const attachment of attachments) {
      const result = await this.attachmentIndexing.indexAttachment(orgId, attachment.id);
      if (result.warning) warnings.push(result.warning);
    }

    return { chunks: await this.countChunks(orgId, articleId), warnings };
  }

  async getArticleIndexStatus(
    orgId: string,
    articleId: number,
  ): Promise<{ chunks: number; lastIndexedAt: string | null }> {
    await this.assertArticleExists(orgId, articleId);

    const [row] = await this.db
      .select({
        chunks: count(),
        lastIndexedAt: sql<string | null>`max(${kbArticleChunks.createdAt})::text`,
      })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.pageId, articleId), eq(kbArticleChunks.orgId, orgId)));

    return { chunks: row?.chunks ?? 0, lastIndexedAt: row?.lastIndexedAt ?? null };
  }

  private async assertArticleExists(orgId: string, articleId: number): Promise<void> {
    const article = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
  }

  private async countChunks(orgId: string, articleId: number): Promise<number> {
    const [row] = await this.db
      .select({ chunks: count() })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.pageId, articleId), eq(kbArticleChunks.orgId, orgId)));
    return row?.chunks ?? 0;
  }
}
