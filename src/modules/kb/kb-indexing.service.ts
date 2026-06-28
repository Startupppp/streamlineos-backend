import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, count, eq, max, sql } from "drizzle-orm";
import { kbArticles, kbArticleChunks } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmbeddingsService, EMBEDDING_MODEL } from "../ai/providers/embeddings.service";

@Injectable()
export class KbIndexingService {
  private readonly logger = new Logger(KbIndexingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
  ) {}

  private chunkText(text: string): string[] {
    const chunkSize = 1500;
    const overlapSize = 200;
    const maxChunks = 400;
    const chunks: string[] = [];

    if (!text || text.trim().length === 0) return chunks;

    let pos = 0;
    while (pos < text.length && chunks.length < maxChunks) {
      const end = Math.min(pos + chunkSize, text.length);
      let chunkEnd = end;

      if (end < text.length) {
        let lastSpace = text.lastIndexOf(" ", end);
        if (lastSpace > pos && lastSpace > pos + chunkSize - 200) {
          chunkEnd = lastSpace;
        }
      }

      const chunk = text.slice(pos, chunkEnd).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      if (end >= text.length) break;

      pos = Math.max(pos + 1, chunkEnd - overlapSize);
    }

    return chunks;
  }

  async indexArticle(orgId: string, articleId: number): Promise<void> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: {
        status: true,
        contentText: true,
      },
    });

    if (!article || article.status !== "published" || !article.contentText?.trim() || !this.embeddings.isConfigured()) {
      await this.removeArticleChunks(orgId, articleId);
      return;
    }

    const chunks = this.chunkText(article.contentText);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.articleId, articleId),
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "article_body"),
          ),
        );

      if (chunks.length === 0) return;

      const embeddings = await Promise.all(chunks.map((chunk) => this.embeddings.embedQuery(chunk)));

      const valuesToInsert = chunks.map((chunk, index) => ({
        orgId,
        articleId,
        attachmentId: null,
        source: "article_body" as const,
        chunkIndex: index,
        content: chunk,
        tokens: Math.ceil(chunk.length / 4),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
      }));

      await tx.insert(kbArticleChunks).values(valuesToInsert);
    });
  }

  async removeArticleChunks(orgId: string, articleId: number): Promise<void> {
    await this.db
      .delete(kbArticleChunks)
      .where(and(eq(kbArticleChunks.articleId, articleId), eq(kbArticleChunks.orgId, orgId)));
  }

  async reindexAll(orgId: string): Promise<{ reindexed: number }> {
    const articles = await this.db.query.kbArticles.findMany({
      where: and(eq(kbArticles.orgId, orgId), eq(kbArticles.status, "published")),
      columns: { id: true },
    });

    for (const article of articles) {
      await this.indexArticle(orgId, article.id);
    }

    return { reindexed: articles.length };
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

    return {
      chunks: row?.chunks ?? 0,
      lastIndexedAt: row?.lastIndexedAt ?? null,
    };
  }

  async reindexArticle(orgId: string, articleId: number): Promise<{ reindexed: boolean }> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");

    await this.indexArticle(orgId, articleId);
    return { reindexed: true };
  }
}
