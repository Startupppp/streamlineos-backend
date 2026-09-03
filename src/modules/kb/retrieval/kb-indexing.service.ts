import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  kbArticles,
  kbPages,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { sha256, chunkText } from "./kb-chunk-utils";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { embedChunksWithResumption } from "./kb-embedding-resumption";
import {
  deleteArticleChunks,
  deletePageChunks,
  loadArticleChunkState,
  loadPageChunkState,
  replaceArticleBodyChunks,
  replacePageBodyChunks,
  updateArticleChunkRevisions,
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
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return embedChunksWithResumption(
      { aiGateway: this.aiGateway, checkpoint: this.checkpoint, logger: this.logger },
      { orgId, contentType, contentId, contentHash, chunks, signal },
    );
  }

  async indexArticle(orgId: string, articleId: number, signal?: AbortSignal): Promise<void> {
    const article = await runInTenantTransaction(this.db, async (tx) =>
      tx.query.kbArticles.findFirst({
        where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
        columns: {
          status: true,
          contentText: true,
          contentRevision: true,
          aclRevision: true,
        },
      }),
    { orgId });

    if (
      !article ||
      article.status !== "published" ||
      !article.contentText?.trim() ||
      !this.aiGateway.isEmbeddingConfigured()
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

    const stored = await loadArticleChunkState(this.db, orgId, articleId);

    const contentRevision = article.contentRevision;
    const aclRevision = article.aclRevision;

    // An unchanged hash returned unconditionally, stranding the chunk ACL: the candidate
    // gate joins acl_revision with `=`, so a restriction change that left the text alone
    // dropped the article out of retrieval until somebody edited its body.
    if (stored?.contentHash === contentHash) {
      if (
        stored.aclRevision === aclRevision &&
        stored.contentRevision === contentRevision
      )
        return;

      this.logger.log("KB article ACL updated (content unchanged)", { orgId, articleId });
      await updateArticleChunkRevisions(this.db, orgId, articleId, {
        aclRevision,
        contentRevision,
      });
      return;
    }

    this.logger.log("KB article indexing started", {
      orgId,
      articleId,
      chunks: chunks.length,
    });

    const embeddings = await this.embed(
      orgId,
      "article",
      articleId,
      contentHash,
      chunks,
      signal,
    );

    await replaceArticleBodyChunks(
      this.db,
      orgId,
      articleId,
      chunks,
      embeddings,
      { contentHash, contentRevision, aclRevision },
      (tx) => this.checkpoint.clearCheckpoints(tx, orgId, "article", articleId),
    );

    this.logger.log("KB article indexing committed", {
      orgId,
      articleId,
      chunks: chunks.length,
    });
  }

  /**
   * The HTTP entry point for a reindex, as distinct from the internal one.
   *
   * `indexPage` treats a page it cannot find as "nothing to index": it drops any stale chunks and
   * returns 0. That is right for the internal callers — a content event may arrive after the page
   * was deleted — and wrong for a request, because `POST /kb/pages/:pageId/reindex` then answered
   * 200 `{"reindexed":true}` for another organisation's page id and for an id belonging to no
   * organisation alike. Measured live by the cross-tenant sweep. Nothing crossed (every statement
   * inside is org-bound) but the caller is told a page was reindexed that does not exist, and the
   * 404 the contract requires is absent.
   *
   * A page in the trash is "not found" for this route too: `deleted_at` is set, `isPageIndexable`
   * refuses it, and `KbPageTreeService.softDelete` already deleted its chunks inside the same
   * transaction as the `deleted_at` write. Resolving a soft-deleted page here answered 200
   * `{"reindexed":true}` for a page the caller can no longer see or index.
   */
  async reindexPageOnRequest(orgId: string, pageId: number): Promise<number> {
    const page = await runInTenantTransaction(
      this.db,
      async (tx) =>
        tx.query.kbPages.findFirst({
          where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
          columns: { id: true },
        }),
      { orgId },
    );
    if (!page) throw new NotFoundException("Page not found");
    return this.indexPage(orgId, pageId);
  }

  async indexPage(orgId: string, pageId: number, signal?: AbortSignal): Promise<number> {
    const page = await runInTenantTransaction(this.db, async (tx) =>
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
    { orgId });

    if (
      !page ||
      !isPageIndexable(page) ||
      !page.contentText?.trim() ||
      !this.aiGateway.isEmbeddingConfigured()
    ) {
      await this.removePageChunks(orgId, pageId);
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

      if (!aclChanged) return 0;

      this.logger.log("KB page ACL updated (content unchanged)", { orgId, pageId });
      await updatePageChunkAcl(this.db, orgId, pageId, acl);
      return 0;
    }

    const chunks = chunkText(page.contentText);

    if (chunks.length === 0) {
      await this.removePageChunks(orgId, pageId);
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

    return chunks.length;
  }

  async removeArticleChunks(orgId: string, articleId: number): Promise<void> {
    await deleteArticleChunks(this.db, orgId, articleId);
  }

  async removePageChunks(orgId: string, pageId: number): Promise<void> {
    await deletePageChunks(this.db, orgId, pageId);
  }

  async bumpSpaceAclRevision(orgId: string, spaceId: number): Promise<void> {
    await Promise.all([
      this.db
        .update(kbPages)
        .set({ aclRevision: sql`acl_revision + 1` })
        .where(and(eq(kbPages.orgId, orgId), eq(kbPages.spaceId, spaceId))),
      this.db
        .update(kbArticles)
        .set({ aclRevision: sql`acl_revision + 1` })
        .where(and(eq(kbArticles.orgId, orgId), eq(kbArticles.spaceId, spaceId))),
    ]);

    const deferred = registerAfterCommit(() => this.syncAclRevisionForSpace(orgId, spaceId));
    if (!deferred) await this.syncAclRevisionForSpace(orgId, spaceId);
  }

  async syncAclRevisionForSpace(orgId: string, spaceId: number): Promise<void> {
    await Promise.all([
      this.db.execute(sql`
        UPDATE kb_article_chunks c
        SET acl_revision = p.acl_revision
        FROM kb_pages p
        WHERE c.page_id = p.id
          AND c.org_id = ${orgId}
          AND p.space_id = ${spaceId}
          AND c.acl_revision != p.acl_revision
      `),
      this.db.execute(sql`
        UPDATE kb_article_chunks c
        SET acl_revision = a.acl_revision
        FROM kb_articles a
        WHERE c.article_id = a.id
          AND c.org_id = ${orgId}
          AND a.space_id = ${spaceId}
          AND c.acl_revision != a.acl_revision
      `),
    ]);
  }

  async reindexAllPages(orgId?: string, afterPageId = 0): Promise<ReindexAllPagesResult> {
    const where = orgId
      ? and(eq(kbPages.orgId, orgId), gt(kbPages.id, afterPageId), ne(kbPages.status, "archived"), isNull(kbPages.deletedAt))
      : and(gt(kbPages.id, afterPageId), ne(kbPages.status, "archived"), isNull(kbPages.deletedAt));

    const pages = await this.db
      .select({ id: kbPages.id, orgId: kbPages.orgId })
      .from(kbPages)
      .where(where)
      .orderBy(asc(kbPages.id))
      .limit(REINDEX_ALL_BATCH_SIZE + 1);

    const batch = pages.slice(0, REINDEX_ALL_BATCH_SIZE);

    for (const page of batch)
      await this.indexPage(page.orgId, page.id);

    return {
      reindexed: batch.length,
      nextPageId: pages.length > REINDEX_ALL_BATCH_SIZE ? (batch.at(-1)?.id ?? null) : null,
    };
  }
}
