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
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { embedChunksWithResumption } from "./kb-embedding-resumption";
import {
  extractAttachmentText,
  isExtractableMime,
} from "./kb-attachment-extract.util";
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
  ): Promise<number[][]> {
    return embedChunksWithResumption(
      {
        aiGateway: this.aiGateway,
        checkpoint: this.checkpoint,
        logger: this.logger,
      },
      { orgId, contentType, contentId, contentHash, chunks },
    );
  }

  async indexSource(
    orgId: string,
    sourceId: number,
    text: string,
  ): Promise<number> {
    if (!this.aiGateway.isEmbeddingConfigured()) return 0;
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await this.removeSourceChunks(orgId, sourceId);
      return 0;
    }

    // The hash is over the SOURCE text, not the rejoined chunks (backend CLAUDE.md §7).
    const contentHash = sha256(text);
    const family = sourceChunks(orgId, sourceId);
    const stored = await loadDerivedChunkState(this.db, family);
    if (stored.chunkCount > 0 && stored.contentHash === contentHash) {
      this.logger.log("KB source text unchanged — reusing stored chunks", {
        orgId,
        sourceId,
        chunks: stored.chunkCount,
      });
      return stored.chunkCount;
    }

    const embeddings = await this.embed(
      orgId,
      "source",
      sourceId,
      contentHash,
      chunks,
    );

    await replaceSourceChunks(
      this.db,
      orgId,
      sourceId,
      chunks,
      embeddings,
      contentHash,
    );

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
    // One statement rather than two: the parent's `acl_revision` is what the candidate join
    // equates against, so it has to be read here and written onto every chunk below. The join
    // is LEFT because an attachment whose page row is gone still has chunks to clear.
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

    if (
      !attachment ||
      attachment.deletedAt !== null ||
      attachment.pageDeletedAt !== null ||
      !this.aiGateway.isEmbeddingConfigured()
    ) {
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
      // No KB bucket override, deliberately: kb_article_attachments rows carry a fileKey
      // the client obtained from POST /storage/upload, which writes to the DEFAULT bucket
      // with no override. Adding one here would 404 the read wherever the buckets differ.
      const { body } = await this.storage.getFileStream(
        orgId,
        attachment.fileKey,
      );
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
      }
      return { chunks: stored.chunkCount, warning: null };
    }

    const embeddings = await this.embed(
      orgId,
      "attachment",
      attachmentId,
      contentHash,
      chunks,
    );

    await replaceAttachmentChunks(
      this.db,
      orgId,
      attachmentId,
      attachment.pageId,
      chunks,
      embeddings,
      {
        contentHash,
        aclRevision,
      },
    );

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
    if (!this.aiGateway.isEmbeddingConfigured() || !isExtractableMime(mimeType))
      return { chunks: 0, warning: null };

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

    if (!page) return { chunks: 0, warning: null };

    let text: string;
    try {
      text = await extractAttachmentText(buffer, mimeType);
    } catch (err) {
      this.logger.error("Page document extract failed", {
        orgId,
        pageId,
        mimeType,
        error: err instanceof Error ? err.message : String(err),
      });
      return { chunks: 0, warning: `${fileName}: could not read file` };
    }

    const chunks = chunkText(text);
    if (chunks.length === 0)
      return { chunks: 0, warning: `${fileName}: no extractable text` };

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
      }
      return { chunks: stored.chunkCount, warning: null };
    }

    const embeddings = await this.embed(
      orgId,
      "page_document",
      pageId,
      contentHash,
      chunks,
    );

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

    return { chunks: chunks.length, warning: null };
  }
}
