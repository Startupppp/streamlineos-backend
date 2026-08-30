import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  kbArticleChunks,
  kbArticles,
  kbArticleAttachments,
  kbPages,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  EmbeddingsService,
  EMBEDDING_MODEL,
} from "../../ai/core/providers/embeddings.service";
import { StorageService } from "../../storage/storage.service";
import {
  extractAttachmentText,
  isExtractableMime,
} from "./kb-attachment-extract.util";
import { sha256, chunkText, streamToBuffer } from "./kb-chunk-utils";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";

export function isPageIndexable(page: {
  status: string;
  deletedAt: Date | null;
}): boolean {
  return page.status !== "archived" && page.deletedAt === null;
}

@Injectable()
export class KbIndexingService {
  private readonly logger = new Logger(KbIndexingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
    private readonly storage: StorageService,
    private readonly checkpoint: KbIngestionCheckpointService,
  ) {}

  private async getPageChunkState(
    orgId: string,
    pageId: number,
  ): Promise<{
    contentHash: string | null;
    pageVisibility: string | null;
    pageProjectId: number | null;
    pageCreatedById: string | null;
    pageCreatedByMembershipId: number | null;
    aclRevision: number | null;
  } | null> {
    const [existing] = await this.db
      .select({
        contentHash: kbArticleChunks.contentHash,
        pageVisibility: kbArticleChunks.pageVisibility,
        pageProjectId: kbArticleChunks.pageProjectId,
        pageCreatedById: kbArticleChunks.pageCreatedById,
        pageCreatedByMembershipId: kbArticleChunks.pageCreatedByMembershipId,
        aclRevision: kbArticleChunks.aclRevision,
      })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.orgId, orgId),
          eq(kbArticleChunks.pageId, pageId),
          eq(kbArticleChunks.source, "page_body"),
        ),
      )
      .limit(1);

    return existing ?? null;
  }

  private async embedWithResumption(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
    chunks: string[],
  ): Promise<number[][]> {
    const cached = await this.checkpoint.loadCheckpoints(
      orgId,
      contentType,
      contentId,
      contentHash,
    );

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i++) {
      const hit = cached.get(i);
      if (hit !== undefined) {
        embeddings.push(hit);
        continue;
      }
      const emb = await this.embeddings.embedQuery(chunks[i]);
      await this.checkpoint.saveCheckpoint(
        orgId,
        contentType,
        contentId,
        contentHash,
        i,
        chunks[i],
        emb,
      );
      embeddings.push(emb);
    }
    return embeddings;
  }

  async indexArticle(orgId: string, articleId: number): Promise<void> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: {
        status: true,
        contentText: true,
        contentRevision: true,
        aclRevision: true,
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

    const chunks = chunkText(article.contentText);
    const contentHash = sha256(article.contentText);

    if (chunks.length === 0) {
      await this.removeArticleChunks(orgId, articleId);
      return;
    }

    const [firstExisting] = await this.db
      .select({ contentHash: kbArticleChunks.contentHash })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.orgId, orgId),
          eq(kbArticleChunks.articleId, articleId),
          eq(kbArticleChunks.source, "article_body"),
        ),
      )
      .limit(1);

    if (firstExisting?.contentHash === contentHash) return;

    const embeddings = await this.embedWithResumption(
      orgId,
      "article",
      articleId,
      contentHash,
      chunks,
    );

    const contentRevision = article.contentRevision;
    const aclRevision = article.aclRevision;

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
        contentRevision,
        aclRevision,
      }));

      await tx.insert(kbArticleChunks).values(valuesToInsert);
      await this.checkpoint.clearCheckpoints(tx, orgId, "article", articleId);
    });
  }

  async indexPage(orgId: string, pageId: number): Promise<number> {
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: {
        status: true,
        visibility: true,
        deletedAt: true,
        contentText: true,
        projectId: true,
        createdById: true,
        createdByMembershipId: true,
        aclRevision: true,
        contentRevision: true,
      },
    });

    if (
      !page ||
      !isPageIndexable(page) ||
      !page.contentText?.trim() ||
      !this.embeddings.isConfigured()
    ) {
      await this.removePageChunks(orgId, pageId);
      return 0;
    }

    const stored = await this.getPageChunkState(orgId, pageId);
    const contentHash = sha256(page.contentText);
    const aclRevision = page.aclRevision;
    const contentRevision = page.contentRevision;

    if (stored !== null && stored.contentHash === contentHash) {
      const aclChanged =
        stored.pageVisibility !== page.visibility ||
        stored.pageProjectId !== page.projectId ||
        stored.pageCreatedById !== page.createdById ||
        stored.pageCreatedByMembershipId !== page.createdByMembershipId ||
        stored.aclRevision !== aclRevision;

      if (!aclChanged) return 0;

      await this.db
        .update(kbArticleChunks)
        .set({
          pageVisibility: page.visibility,
          pageProjectId: page.projectId,
          pageCreatedById: page.createdById,
          pageCreatedByMembershipId: page.createdByMembershipId,
          aclRevision,
        })
        .where(
          and(
            eq(kbArticleChunks.pageId, pageId),
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "page_body"),
          ),
        );
      return 0;
    }

    const chunks = chunkText(page.contentText);

    if (chunks.length === 0) {
      await this.removePageChunks(orgId, pageId);
      return 0;
    }

    const embeddings = await this.embedWithResumption(
      orgId,
      "page",
      pageId,
      contentHash,
      chunks,
    );

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
        pageVisibility: page.visibility,
        pageProjectId: page.projectId,
        pageCreatedById: page.createdById,
        pageCreatedByMembershipId: page.createdByMembershipId,
        aclRevision,
        contentRevision,
      }));

      await tx.insert(kbArticleChunks).values(valuesToInsert);
      await this.checkpoint.clearCheckpoints(tx, orgId, "page", pageId);
    });

    return chunks.length;
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
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await this.removeSourceChunks(orgId, sourceId);
      return 0;
    }

    const embeddings = await Promise.all(
      chunks.map((c) => this.embeddings.embedQuery(c)),
    );

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
      const { body } = await this.storage.getFileStream(orgId, attachment.fileKey);
      const buffer = await streamToBuffer(body);
      text = await extractAttachmentText(buffer, attachment.mimeType);
    } catch (err) {
      this.logger.error(`Attachment extract failed (${attachmentId}): ${err}`);
      return {
        chunks: 0,
        warning: `${attachment.fileName}: could not read file`,
      };
    }

    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      return { chunks: 0, warning: `${attachment.fileName}: no extractable text` };
    }

    const embeddings = await Promise.all(
      chunks.map((c) => this.embeddings.embedQuery(c)),
    );

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

    return { chunks: chunks.length, warning: null };
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
    if (!this.embeddings.isConfigured() || !isExtractableMime(mimeType))
      return { chunks: 0, warning: null };

    let text: string;
    try {
      text = await extractAttachmentText(buffer, mimeType);
    } catch (err) {
      this.logger.error(
        `Page document extract failed (page ${pageId}, ${fileName}): ${err}`,
      );
      return { chunks: 0, warning: `${fileName}: could not read file` };
    }

    const chunks = chunkText(text);
    if (chunks.length === 0)
      return { chunks: 0, warning: `${fileName}: no extractable text` };

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

  async reindexAllPages(orgId?: string): Promise<{ reindexed: number }> {
    const where = orgId
      ? and(eq(kbPages.orgId, orgId), ne(kbPages.status, "archived"), isNull(kbPages.deletedAt))
      : and(ne(kbPages.status, "archived"), isNull(kbPages.deletedAt));

    const pages = await this.db
      .select({ id: kbPages.id, orgId: kbPages.orgId })
      .from(kbPages)
      .where(where);

    for (const page of pages)
      await this.indexPage(page.orgId, page.id);

    return { reindexed: pages.length };
  }
}
