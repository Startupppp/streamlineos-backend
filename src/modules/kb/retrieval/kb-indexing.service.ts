import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../db/drizzle.types";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import {
  KbIndexingMetrics,
  kbIndexingOutcomeForError,
  type KbIndexingContentType,
} from "../core/telemetry/kb-indexing-metrics";
import { sha256, chunkText } from "./kb-chunk-utils";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { embedChunksWithResumption } from "./kb-embedding-resumption";
import {
  deletePageChunks,
  loadPageChunkState,
  replacePageBodyChunks,
  updatePageChunkAcl,
} from "./kb-chunk-repository";

export function isPageIndexable(page: {
  status: string;
  deletedAt: Date | null;
}): boolean {
  return page.status !== "archived" && page.deletedAt === null;
}

const REINDEX_ALL_BATCH_SIZE = 100;

export interface ReindexAllPagesResult {
  reindexed: number;
  nextPageId: number | null;
}

@Injectable()
export class KbIndexingService {
  private readonly logger = new Logger(KbIndexingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly checkpoint: KbIngestionCheckpointService,
  ) {}

  private embed(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
    chunks: string[],
    metrics: KbIndexingMetrics,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return embedChunksWithResumption(
      {
        aiGateway: this.aiGateway,
        checkpoint: this.checkpoint,
        logger: this.logger,
        metrics,
      },
      { orgId, contentType, contentId, contentHash, chunks, signal },
    );
  }

  async indexArticle(
    orgId: string,
    articleId: number,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.indexPage(orgId, articleId, signal, "article");
  }

  async reindexPageOnRequest(orgId: string, pageId: number): Promise<number> {
    const page = await runInTenantTransaction(
      this.db,
      async (tx) =>
        tx.query.kbPages.findFirst({
          where: and(
            eq(kbPages.id, pageId),
            eq(kbPages.orgId, orgId),
            isNull(kbPages.deletedAt),
          ),
          columns: { id: true },
        }),
      { orgId },
    );
    if (!page) throw new NotFoundException("Page not found");
    return this.indexPage(orgId, pageId);
  }

  async indexPage(
    orgId: string,
    pageId: number,
    signal?: AbortSignal,
    contentType: KbIndexingContentType = "page",
  ): Promise<number> {
    const metrics = KbIndexingMetrics.begin({ contentType, orgId });
    try {
      return await this.indexPageMeasured(orgId, pageId, metrics, signal);
    } catch (error) {
      metrics.finish(kbIndexingOutcomeForError(error));
      throw error;
    }
  }

  private async indexPageMeasured(
    orgId: string,
    pageId: number,
    metrics: KbIndexingMetrics,
    signal?: AbortSignal,
  ): Promise<number> {
    const page = await runInTenantTransaction(
      this.db,
      async (tx) =>
        tx.query.kbPages.findFirst({
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
        }),
      { orgId },
    );

    if (!page || !isPageIndexable(page) || !page.contentText?.trim()) {
      await this.removePageChunks(orgId, pageId);
      metrics.finish("skipped_no_content");
      return 0;
    }

    if (!this.aiGateway.isEmbeddingConfigured()) {
      await this.removePageChunks(orgId, pageId);
      metrics.finish("embedding_unavailable");
      return 0;
    }

    const stored = await loadPageChunkState(this.db, orgId, pageId);
    const contentHash = sha256(page.contentText);
    const acl = {
      pageVisibility: page.visibility,
      pageProjectId: page.projectId,
      pageCreatedById: page.createdById,
      pageCreatedByMembershipId: page.createdByMembershipId,
      aclRevision: page.aclRevision,
    };
    const contentRevision = page.contentRevision;

    if (stored !== null && stored.contentHash === contentHash) {
      const aclChanged =
        stored.pageVisibility !== acl.pageVisibility ||
        stored.pageProjectId !== acl.pageProjectId ||
        stored.pageCreatedById !== acl.pageCreatedById ||
        stored.pageCreatedByMembershipId !== acl.pageCreatedByMembershipId ||
        stored.aclRevision !== acl.aclRevision;

      if (!aclChanged) {
        metrics.finish("reused", { reused: true });
        return 0;
      }

      this.logger.log("KB page ACL updated (content unchanged)", {
        orgId,
        pageId,
      });
      await updatePageChunkAcl(this.db, orgId, pageId, acl);
      metrics.finish("acl_only", { reused: true });
      return 0;
    }

    const chunks = chunkText(page.contentText);

    if (chunks.length === 0) {
      await this.removePageChunks(orgId, pageId);
      metrics.finish("skipped_no_content");
      return 0;
    }

    this.logger.log("KB page indexing started", {
      orgId,
      pageId,
      chunks: chunks.length,
    });

    const embeddings = await this.embed(
      orgId,
      "page",
      pageId,
      contentHash,
      chunks,
      metrics,
      signal,
    );

    await replacePageBodyChunks(
      this.db,
      orgId,
      pageId,
      chunks,
      embeddings,
      { ...acl, contentHash, contentRevision },
      (tx) => this.checkpoint.clearCheckpoints(tx, orgId, "page", pageId),
    );

    this.logger.log("KB page indexing committed", {
      orgId,
      pageId,
      chunks: chunks.length,
    });

    metrics.finish("indexed", { chunks: chunks.length, reused: false });
    return chunks.length;
  }

  async removePageChunks(orgId: string, pageId: number): Promise<void> {
    await deletePageChunks(this.db, orgId, pageId);
  }

  async bumpSpaceAclRevision(orgId: string, spaceId: number): Promise<void> {
    await this.db
      .update(kbPages)
      .set({ aclRevision: sql`acl_revision + 1`, aclRevisionChangedAt: new Date() })
      .where(and(eq(kbPages.orgId, orgId), eq(kbPages.spaceId, spaceId)));

    const deferred = registerAfterCommit(() =>
      this.syncAclRevisionForSpace(orgId, spaceId),
    );
    if (!deferred) await this.syncAclRevisionForSpace(orgId, spaceId);
  }

  async syncAclRevisionForSpace(orgId: string, spaceId: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE kb_article_chunks c
      SET acl_revision = p.acl_revision,
          acl_synced_at = NOW()
      FROM kb_pages p
      WHERE c.page_id = p.id
        AND c.org_id = ${orgId}
        AND p.space_id = ${spaceId}
        AND c.acl_revision != p.acl_revision
    `);
  }

  async reindexAllPages(
    orgId?: string,
    afterPageId = 0,
  ): Promise<ReindexAllPagesResult> {
    const where = orgId
      ? and(
          eq(kbPages.orgId, orgId),
          gt(kbPages.id, afterPageId),
          ne(kbPages.status, "archived"),
          isNull(kbPages.deletedAt),
        )
      : and(
          gt(kbPages.id, afterPageId),
          ne(kbPages.status, "archived"),
          isNull(kbPages.deletedAt),
        );

    const listPages = async (tx: TenantTx) =>
      tx
        .select({ id: kbPages.id, orgId: kbPages.orgId })
        .from(kbPages)
        .where(where)
        .orderBy(asc(kbPages.id))
        .limit(REINDEX_ALL_BATCH_SIZE + 1);

    // No `orgId` means the platform-wide sweep, which has no single tenant to open for and
    // runs under a caller that already established one.
    const pages = orgId
      ? await runInTenantTransaction(this.db, listPages, { orgId })
      : await runInTenantTransaction(this.db, listPages);

    const batch = pages.slice(0, REINDEX_ALL_BATCH_SIZE);

    for (const page of batch) await this.indexPage(page.orgId, page.id);

    return {
      reindexed: batch.length,
      nextPageId:
        pages.length > REINDEX_ALL_BATCH_SIZE
          ? (batch.at(-1)?.id ?? null)
          : null,
    };
  }
}
