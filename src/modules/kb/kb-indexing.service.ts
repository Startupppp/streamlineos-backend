import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Readable } from "stream";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import {
  kbArticles,
  kbArticleAttachments,
  kbArticleChunks,
  kbPages,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  EmbeddingsService,
  EMBEDDING_MODEL,
} from "../ai/core/providers/embeddings.service";
import { StorageService } from "../storage/storage.service";
import {
  extractAttachmentText,
  isExtractableMime,
} from "./kb-attachment-extract.util";

export function isPageIndexable(page: {
  status: string;
  visibility: string;
  deletedAt: Date | null;
}): boolean {
  return (
    page.status !== "archived" &&
    (page.visibility === "org" || page.visibility === "public") &&
    page.deletedAt === null
  );
}

@Injectable()
export class KbIndexingService {
  private readonly logger = new Logger(KbIndexingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
    private readonly storage: StorageService,
  ) {}

  private sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  private async isContentUnchanged(
    orgId: string,
    filter: { articleId: number } | { pageId: number },
    source: "article_body" | "page_body",
    newText: string,
  ): Promise<boolean> {
    const idCondition =
      "articleId" in filter
        ? eq(kbArticleChunks.articleId, filter.articleId)
        : eq(kbArticleChunks.pageId, filter.pageId);

    const [existing] = await this.db
      .select({ contentHash: kbArticleChunks.contentHash })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.orgId, orgId),
          idCondition,
          eq(kbArticleChunks.source, source),
        ),
      )
      .limit(1);

    if (!existing?.contentHash) return false;
    return existing.contentHash === this.sha256(newText);
  }

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
        const lastSpace = text.lastIndexOf(" ", end);
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

    if (
      !article ||
      article.status !== "published" ||
      !article.contentText?.trim() ||
      !this.embeddings.isConfigured()
    ) {
      await this.removeArticleChunks(orgId, articleId);
      return;
    }

    const unchanged = await this.isContentUnchanged(
      orgId,
      { articleId: articleId },
      "article_body",
      article.contentText,
    );
    if (unchanged) return;

    const chunks = this.chunkText(article.contentText);
    const contentHash = this.sha256(article.contentText);

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

      const embeddings = await Promise.all(
        chunks.map((chunk) => this.embeddings.embedQuery(chunk)),
      );

      const valuesToInsert = chunks.map((chunk, index) => ({
        orgId,
        articleId,
        pageId: null,
        attachmentId: null,
        source: "article_body" as const,
        chunkIndex: index,
        content: chunk,
        contentHash,
        tokens: Math.ceil(chunk.length / 4),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
      }));

      await tx.insert(kbArticleChunks).values(valuesToInsert);
    });
  }

  async indexPage(orgId: string, pageId: number): Promise<void> {
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: {
        status: true,
        visibility: true,
        deletedAt: true,
        contentText: true,
      },
    });

    if (
      !page ||
      !isPageIndexable(page) ||
      !page.contentText?.trim() ||
      !this.embeddings.isConfigured()
    ) {
      await this.removePageChunks(orgId, pageId);
      return;
    }

    const unchanged = await this.isContentUnchanged(
      orgId,
      { pageId },
      "page_body",
      page.contentText,
    );
    if (unchanged) return;

    const chunks = this.chunkText(page.contentText);
    const contentHash = this.sha256(page.contentText);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.pageId, pageId),
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "page_body"),
          ),
        );

      if (chunks.length === 0) return;

      const embeddings = await Promise.all(
        chunks.map((chunk) => this.embeddings.embedQuery(chunk)),
      );

      const valuesToInsert = chunks.map((chunk, index) => ({
        orgId,
        articleId: null,
        pageId,
        attachmentId: null,
        source: "page_body" as const,
        chunkIndex: index,
        content: chunk,
        contentHash,
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
      .where(
        and(
          eq(kbArticleChunks.articleId, articleId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      );
  }

  async removePageChunks(orgId: string, pageId: number): Promise<void> {
    await this.db
      .delete(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.pageId, pageId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      );
  }

  async indexSource(
    orgId: string,
    sourceId: number,
    text: string,
  ): Promise<number> {
    if (!this.embeddings.isConfigured()) return 0;
    const chunks = this.chunkText(text);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.sourceId, sourceId),
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "source"),
          ),
        );

      if (chunks.length === 0) return;

      const embeddings = await Promise.all(
        chunks.map((c) => this.embeddings.embedQuery(c)),
      );

      const valuesToInsert = chunks.map((chunk, index) => ({
        orgId,
        articleId: null,
        pageId: null,
        attachmentId: null,
        sourceId,
        source: "source" as const,
        chunkIndex: index,
        content: chunk,
        tokens: Math.ceil(chunk.length / 4),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
      }));

      await tx.insert(kbArticleChunks).values(valuesToInsert);
    });

    return chunks.length;
  }

  async removeSourceChunks(orgId: string, sourceId: number): Promise<void> {
    await this.db
      .delete(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.sourceId, sourceId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      );
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
      );
    }
    return Buffer.concat(chunks);
  }

  async indexAttachment(
    orgId: string,
    attachmentId: number,
  ): Promise<{ chunks: number; warning: string | null }> {
    const attachment = await this.db.query.kbArticleAttachments.findFirst({
      where: and(
        eq(kbArticleAttachments.id, attachmentId),
        eq(kbArticleAttachments.orgId, orgId),
      ),
      columns: {
        id: true,
        articleId: true,
        fileKey: true,
        mimeType: true,
        fileName: true,
      },
    });

    if (!attachment || !this.embeddings.isConfigured()) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      return { chunks: 0, warning: null };
    }

    if (!isExtractableMime(attachment.mimeType)) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      return {
        chunks: 0,
        warning: `${attachment.fileName}: unsupported file type`,
      };
    }

    let text: string;
    try {
      const { body } = await this.storage.getFileStream(attachment.fileKey);
      const buffer = await this.streamToBuffer(body);
      text = await extractAttachmentText(buffer, attachment.mimeType);
    } catch (err) {
      this.logger.error(`Attachment extract failed (${attachmentId}): ${err}`);
      return {
        chunks: 0,
        warning: `${attachment.fileName}: could not read file`,
      };
    }

    const chunks = this.chunkText(text);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.attachmentId, attachmentId),
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "attachment"),
          ),
        );

      if (chunks.length === 0) return;

      const embeddings = await Promise.all(
        chunks.map((c) => this.embeddings.embedQuery(c)),
      );

      const valuesToInsert = chunks.map((chunk, index) => ({
        orgId,
        articleId: attachment.articleId,
        pageId: null,
        attachmentId,
        source: "attachment" as const,
        chunkIndex: index,
        content: chunk,
        tokens: Math.ceil(chunk.length / 4),
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
      }));

      await tx.insert(kbArticleChunks).values(valuesToInsert);
    });

    return {
      chunks: chunks.length,
      warning:
        chunks.length === 0
          ? `${attachment.fileName}: no extractable text`
          : null,
    };
  }

  async removeAttachmentChunks(
    orgId: string,
    attachmentId: number,
  ): Promise<void> {
    await this.db
      .delete(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.attachmentId, attachmentId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      );
  }

  async indexPageDocument(
    orgId: string,
    pageId: number,
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<{ chunks: number; warning: string | null }> {
    if (!this.embeddings.isConfigured() || !isExtractableMime(mimeType)) {
      return { chunks: 0, warning: null };
    }

    let text: string;
    try {
      text = await extractAttachmentText(buffer, mimeType);
    } catch (err) {
      this.logger.error(
        `Page document extract failed (page ${pageId}, ${fileName}): ${err}`,
      );
      return { chunks: 0, warning: `${fileName}: could not read file` };
    }

    const chunks = this.chunkText(text);
    if (chunks.length === 0) {
      return { chunks: 0, warning: `${fileName}: no extractable text` };
    }

    const embeddings = await Promise.all(
      chunks.map((c) => this.embeddings.embedQuery(c)),
    );

    const valuesToInsert = chunks.map((chunk, index) => ({
      orgId,
      articleId: null,
      pageId,
      attachmentId: null,
      source: "attachment" as const,
      chunkIndex: index,
      content: chunk,
      tokens: Math.ceil(chunk.length / 4),
      embedding: embeddings[index],
      embeddingModel: EMBEDDING_MODEL,
    }));

    await this.db.insert(kbArticleChunks).values(valuesToInsert);

    return { chunks: chunks.length, warning: null };
  }

  async reindexAll(orgId: string): Promise<{
    total: number;
    indexed: number;
    totalChunks: number;
    failures: { articleId: number; error: string }[];
  }> {
    const articles = await this.db.query.kbArticles.findMany({
      where: and(
        eq(kbArticles.orgId, orgId),
        eq(kbArticles.status, "published"),
      ),
      columns: { id: true },
    });

    const REINDEX_CONCURRENCY = 4;
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
        else
          failures.push({ articleId: result.articleId, error: result.error });
      }
    }

    const [row] = await this.db
      .select({ chunks: count() })
      .from(kbArticleChunks)
      .where(eq(kbArticleChunks.orgId, orgId));

    return {
      total: articles.length,
      indexed,
      totalChunks: row?.chunks ?? 0,
      failures,
    };
  }

  async reindexAllPages(orgId?: string): Promise<{ reindexed: number }> {
    const indexable = sql`${kbPages.visibility} IN ('org', 'public') AND ${kbPages.status} <> 'archived'`;
    const where = orgId
      ? and(eq(kbPages.orgId, orgId), indexable, isNull(kbPages.deletedAt))
      : and(indexable, isNull(kbPages.deletedAt));

    const pages = await this.db
      .select({ id: kbPages.id, orgId: kbPages.orgId })
      .from(kbPages)
      .where(where);

    for (const page of pages) {
      await this.indexPage(page.orgId, page.id);
    }

    return { reindexed: pages.length };
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
        lastIndexedAt: sql<
          string | null
        >`max(${kbArticleChunks.createdAt})::text`,
      })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.articleId, articleId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      );

    return {
      chunks: row?.chunks ?? 0,
      lastIndexedAt: row?.lastIndexedAt ?? null,
    };
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

    await this.indexArticle(orgId, articleId);

    const attachments = await this.db.query.kbArticleAttachments.findMany({
      where: and(
        eq(kbArticleAttachments.articleId, articleId),
        eq(kbArticleAttachments.orgId, orgId),
      ),
      columns: { id: true },
    });

    const warnings: string[] = [];
    for (const attachment of attachments) {
      const result = await this.indexAttachment(orgId, attachment.id);
      if (result.warning) warnings.push(result.warning);
    }

    const [row] = await this.db
      .select({ chunks: count() })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.articleId, articleId),
          eq(kbArticleChunks.orgId, orgId),
        ),
      );

    return { chunks: row?.chunks ?? 0, warnings };
  }
}
