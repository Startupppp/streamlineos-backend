import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  kbArticleChunks,
  kbPageAttachments,
  kbPages,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { StorageService } from "../../storage/storage.service";
import { isSensitiveStorageKey } from "../../storage/storage-key";
import {
  KbIndexingMetrics,
  kbIndexingOutcomeForError,
} from "../core/telemetry/kb-indexing-metrics";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { embedChunksWithResumption } from "./kb-embedding-resumption";
import {
  extractDocumentText,
  isExtractableMime,
} from "../../../common/documents/extract-document-text.util";
import { chunkText, sha256, streamToBuffer } from "./kb-chunk-utils";
import {
  attachmentChunks,
  loadDerivedChunkState,
  pageDocumentChunks,
  replaceAttachmentChunks,
  replacePageDocumentChunks,
  replaceSourceChunks,
  sourceChunks,
  updateDerivedChunkAcl,
} from "./kb-derived-chunk-state";

@Injectable()
export class KbAttachmentIndexingService {
  private readonly logger = new Logger(KbAttachmentIndexingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly storage: StorageService,
    private readonly checkpoint: KbIngestionCheckpointService,
  ) {}

  private embed(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
    chunks: string[],
    metrics?: KbIndexingMetrics,
  ): Promise<number[][]> {
    return embedChunksWithResumption(
      {
        aiGateway: this.aiGateway,
        checkpoint: this.checkpoint,
        logger: this.logger,
        metrics,
      },
      { orgId, contentType, contentId, contentHash, chunks },
    );
  }

  async indexSource(
    orgId: string,
    sourceId: number,
    text: string,
  ): Promise<number> {
    const metrics = KbIndexingMetrics.begin({ contentType: "article", orgId });
    try {
      if (!this.aiGateway.isEmbeddingConfigured()) {
        metrics.finish("embedding_unavailable");
        return 0;
      }
      const chunks = chunkText(text);

      if (chunks.length === 0) {
        await this.removeSourceChunks(orgId, sourceId);
        metrics.finish("skipped_no_content");
        return 0;
      }

      const contentHash = sha256(text);
      const family = sourceChunks(orgId, sourceId);
      const stored = await loadDerivedChunkState(this.db, family);
      if (stored.chunkCount > 0 && stored.contentHash === contentHash) {
        this.logger.log("KB source text unchanged — reusing stored chunks", {
          orgId,
          sourceId,
          chunks: stored.chunkCount,
        });
        metrics.finish("reused", { reused: true });
        return stored.chunkCount;
      }

      const embeddings = await this.embed(orgId, "source", sourceId, contentHash, chunks, metrics);

      await replaceSourceChunks(this.db, orgId, sourceId, chunks, embeddings, contentHash);

      metrics.finish("indexed", { chunks: chunks.length, reused: false });
      return chunks.length;
    } catch (error) {
      metrics.finish(kbIndexingOutcomeForError(error));
      throw error;
    }
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
    const metrics = KbIndexingMetrics.begin({ contentType: "attachment", orgId });
    try {
      return await this.indexAttachmentMeasured(orgId, attachmentId, metrics);
    } catch (error) {
      metrics.finish(kbIndexingOutcomeForError(error));
      throw error;
    }
  }

  private async indexAttachmentMeasured(
    orgId: string,
    attachmentId: number,
    metrics: KbIndexingMetrics,
  ): Promise<{ chunks: number; warning: string | null }> {
    const [attachment] = await this.db
      .select({
        pageId: kbPageAttachments.pageId,
        fileKey: kbPageAttachments.fileKey,
        mimeType: kbPageAttachments.mimeType,
        fileName: kbPageAttachments.fileName,
        deletedAt: kbPageAttachments.deletedAt,
        pageAclRevision: kbPages.aclRevision,
        pageDeletedAt: kbPages.deletedAt,
      })
      .from(kbPageAttachments)
      .leftJoin(
        kbPages,
        and(
          eq(kbPages.id, kbPageAttachments.pageId),
          eq(kbPages.orgId, kbPageAttachments.orgId),
        ),
      )
      .where(
        and(
          eq(kbPageAttachments.id, attachmentId),
          eq(kbPageAttachments.orgId, orgId),
        ),
      )
      .limit(1);

    if (!attachment || attachment.deletedAt !== null || attachment.pageDeletedAt !== null) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      metrics.finish("skipped_no_content");
      return { chunks: 0, warning: null };
    }

    if (isSensitiveStorageKey(attachment.fileKey, orgId)) {
      metrics.finish("skipped_no_content");
      return {
        chunks: 0,
        warning: `${attachment.fileName}: file is in a protected folder and is not indexed`,
      };
    }

    if (!this.aiGateway.isEmbeddingConfigured()) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      metrics.finish("embedding_unavailable");
      return { chunks: 0, warning: null };
    }

    if (!isExtractableMime(attachment.mimeType)) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      metrics.finish("skipped_no_content");
      return {
        chunks: 0,
        warning: `${attachment.fileName}: unsupported file type`,
      };
    }

    let text: string;
    try {
      const { body } = await this.storage.getFileStream(orgId, attachment.fileKey);
      const buffer = await streamToBuffer(body);
      text = await extractDocumentText(buffer, attachment.mimeType);
    } catch (err) {
      this.logger.error(`Attachment extract failed (${attachmentId}): ${err}`);
      metrics.finish("error");
      return {
        chunks: 0,
        warning: `${attachment.fileName}: could not read file`,
      };
    }

    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await this.removeAttachmentChunks(orgId, attachmentId);
      metrics.finish("skipped_no_content");
      return {
        chunks: 0,
        warning: `${attachment.fileName}: no extractable text`,
      };
    }

    const aclRevision = attachment.pageAclRevision ?? 1;
    const contentHash = sha256(text);
    const family = attachmentChunks(orgId, attachmentId);
    const stored = await loadDerivedChunkState(this.db, family);
    if (stored.chunkCount > 0 && stored.contentHash === contentHash) {
      if (stored.aclRevision !== aclRevision) {
        this.logger.log("KB attachment ACL updated (text unchanged)", {
          orgId,
          attachmentId,
          aclRevision,
        });
        await updateDerivedChunkAcl(this.db, family, aclRevision);
        metrics.finish("acl_only", { reused: true });
      } else {
        metrics.finish("reused", { reused: true });
      }
      return { chunks: stored.chunkCount, warning: null };
    }

    const embeddings = await this.embed(orgId, "attachment", attachmentId, contentHash, chunks, metrics);

    await replaceAttachmentChunks(
      this.db,
      orgId,
      attachmentId,
      attachment.pageId,
      chunks,
      embeddings,
      { contentHash, aclRevision },
    );

    metrics.finish("indexed", { chunks: chunks.length, reused: false });
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
    const metrics = KbIndexingMetrics.begin({ contentType: "attachment", orgId });
    try {
      return await this.indexPageDocumentMeasured(orgId, pageId, buffer, mimeType, fileName, metrics);
    } catch (error) {
      metrics.finish(kbIndexingOutcomeForError(error));
      throw error;
    }
  }

  private async indexPageDocumentMeasured(
    orgId: string,
    pageId: number,
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    metrics: KbIndexingMetrics,
  ): Promise<{ chunks: number; warning: string | null }> {
    if (!this.aiGateway.isEmbeddingConfigured()) {
      metrics.finish("embedding_unavailable");
      return { chunks: 0, warning: null };
    }

    if (!isExtractableMime(mimeType)) {
      metrics.finish("skipped_no_content");
      return { chunks: 0, warning: null };
    }

    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
      ),
      columns: {
        visibility: true,
        projectId: true,
        createdById: true,
        createdByMembershipId: true,
        aclRevision: true,
      },
    });

    if (!page) {
      metrics.finish("skipped_no_content");
      return { chunks: 0, warning: null };
    }

    let text: string;
    try {
      text = await extractDocumentText(buffer, mimeType);
    } catch (err) {
      this.logger.error("Page document extract failed", {
        orgId,
        pageId,
        mimeType,
        error: err instanceof Error ? err.message : String(err),
      });
      metrics.finish("error");
      return { chunks: 0, warning: `${fileName}: could not read file` };
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      metrics.finish("skipped_no_content");
      return { chunks: 0, warning: `${fileName}: no extractable text` };
    }

    const contentHash = sha256(text);
    const family = pageDocumentChunks(orgId, pageId);
    const stored = await loadDerivedChunkState(this.db, family);
    if (stored.chunkCount > 0 && stored.contentHash === contentHash) {
      if (stored.aclRevision !== page.aclRevision) {
        this.logger.log("KB page document ACL updated (text unchanged)", {
          orgId,
          pageId,
        });
        await updateDerivedChunkAcl(this.db, family, page.aclRevision);
        metrics.finish("acl_only", { reused: true });
      } else {
        metrics.finish("reused", { reused: true });
      }
      return { chunks: stored.chunkCount, warning: null };
    }

    const embeddings = await this.embed(orgId, "page_document", pageId, contentHash, chunks, metrics);

    await replacePageDocumentChunks(
      this.db,
      orgId,
      pageId,
      chunks,
      embeddings,
      {
        contentHash,
        aclRevision: page.aclRevision,
        pageProjectId: page.projectId,
        pageVisibility: page.visibility,
        pageCreatedById: page.createdById,
        pageCreatedByMembershipId: page.createdByMembershipId,
      },
    );

    metrics.finish("indexed", { chunks: chunks.length, reused: false });
    return { chunks: chunks.length, warning: null };
  }
}
