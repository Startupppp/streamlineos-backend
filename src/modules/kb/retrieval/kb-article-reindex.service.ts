import { Injectable, NotFoundException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import { kbArticles, kbArticleChunks, kbArticleAttachments } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { sql } from "drizzle-orm";
import { KbIndexingService } from "./kb-indexing.service";

const REINDEX_CONCURRENCY = 4;

@Injectable()
export class KbArticleReindexService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly indexing: KbIndexingService,
  ) {}

  async reindexAll(orgId: string): Promise<{
    total: number;
    indexed: number;
    totalChunks: number;
    failures: { articleId: number; error: string }[];
  }> {
    const articles = await this.db.query.kbArticles.findMany({
      where: and(eq(kbArticles.orgId, orgId), eq(kbArticles.status, "published")),
      columns: { id: true },
    });

    const failures: { articleId: number; error: string }[] = [];
    let indexed = 0;
    for (let i = 0; i < articles.length; i += REINDEX_CONCURRENCY) {
      const batch = articles.slice(i, i + REINDEX_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (article) => {
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

    return { total: articles.length, indexed, totalChunks: row?.chunks ?? 0, failures };
  }

  async reindexArticle(
    orgId: string,
    articleId: number,
  ): Promise<{ chunks: number; warnings: string[] }> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");

    await this.indexing.indexArticle(orgId, articleId);

    const attachments = await this.db.query.kbArticleAttachments.findMany({
      where: and(
        eq(kbArticleAttachments.articleId, articleId),
        eq(kbArticleAttachments.orgId, orgId),
      ),
      columns: { id: true },
    });

    const warnings: string[] = [];
    for (const attachment of attachments) {
      const result = await this.indexing.indexAttachment(orgId, attachment.id);
      if (result.warning) warnings.push(result.warning);
    }

    const [row] = await this.db
      .select({ chunks: count() })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.articleId, articleId), eq(kbArticleChunks.orgId, orgId)));

    return { chunks: row?.chunks ?? 0, warnings };
  }

  async getArticleIndexStatus(
    orgId: string,
    articleId: number,
  ): Promise<{ chunks: number; lastIndexedAt: string | null }> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");

    const [row] = await this.db
      .select({
        chunks: count(),
        lastIndexedAt: sql<string | null>`max(${kbArticleChunks.createdAt})::text`,
      })
      .from(kbArticleChunks)
      .where(and(eq(kbArticleChunks.articleId, articleId), eq(kbArticleChunks.orgId, orgId)));

    return { chunks: row?.chunks ?? 0, lastIndexedAt: row?.lastIndexedAt ?? null };
  }
}
