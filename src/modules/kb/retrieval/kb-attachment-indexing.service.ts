import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbArticleChunks, kbArticleAttachments, kbPages } from "../../../db/schema";
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
import { chunkText, streamToBuffer } from "./kb-chunk-utils";

const EMBED_BATCH_SIZE = 64;

@Injectable()
export class KbAttachmentIndexingService {
  private readonly logger = new Logger(KbAttachmentIndexingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
    private readonly storage: StorageService,
  ) {}

  private async embedInBatches(orgId: string, chunks: string[], feature = "kb.indexing"): Promise<number[][]> {
    const result: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batchEmbeddings = await this.embeddings.embedBatch(chunks.slice(i, i + EMBED_BATCH_SIZE), orgId, feature);
      result.push(...batchEmbeddings);
    }
    return result;
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

    const embeddings = await this.embedInBatches(orgId, chunks);

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

    const embeddings = await this.embedInBatches(orgId, chunks);

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

    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: {
        visibility: true,
        projectId: true,
        createdById: true,
        createdByMembershipId: true,
        aclRevision: true,
      },
    });

    if (!page) return { chunks: 0, warning: null };

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

    const embeddings = await this.embedInBatches(orgId, chunks);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.pageId, pageId),
            eq(kbArticleChunks.orgId, orgId),
            eq(kbArticleChunks.source, "attachment"),
          ),
        );

      await tx.insert(kbArticleChunks).values(
        chunks.map((chunk, index) => ({
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
          pageVisibility: page.visibility,
          pageProjectId: page.projectId,
          pageCreatedById: page.createdById,
          pageCreatedByMembershipId: page.createdByMembershipId,
          aclRevision: page.aclRevision,
        })),
      );
    });

    return { chunks: chunks.length, warning: null };
  }
}
