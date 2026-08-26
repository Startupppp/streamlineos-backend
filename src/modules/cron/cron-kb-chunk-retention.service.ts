import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { kbArticleChunks, kbArticles, kbPages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";

const PRUNE_BATCH_SIZE = 500;

export interface KbChunkRetentionResult {
  orgsProcessed: number;
  articleChunksPruned: number;
  pageChunksPruned: number;
}

@Injectable()
export class CronKbChunkRetentionService {
  private readonly logger = new Logger(CronKbChunkRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async pruneStaleChunks(): Promise<KbChunkRetentionResult> {
    let articleChunksPruned = 0;
    let pageChunksPruned = 0;

    const result = await forEachOrg(this.db, "kb-chunk-retention", async (tx, orgId) => {
      articleChunksPruned += await this.pruneArticleChunksForOrg(tx, orgId);
      pageChunksPruned += await this.prunePageChunksForOrg(tx, orgId);
    });

    this.logger.log(
      `KB chunk retention: pruned ${articleChunksPruned} article chunks, ${pageChunksPruned} page chunks across ${result.succeeded} orgs`,
    );

    return { orgsProcessed: result.succeeded, articleChunksPruned, pageChunksPruned };
  }

  private async pruneArticleChunksForOrg(tx: TenantTx, orgId: string): Promise<number> {
    let pruned = 0;

    for (;;) {
      const rows = await tx
        .select({ id: kbArticleChunks.id })
        .from(kbArticleChunks)
        .leftJoin(kbArticles, and(
          eq(kbArticles.id, kbArticleChunks.articleId),
          eq(kbArticles.orgId, orgId),
        ))
        .where(and(
          eq(kbArticleChunks.orgId, orgId),
          isNotNull(kbArticleChunks.articleId),
          or(
            isNull(kbArticles.id),
            ne(kbArticles.status, "published"),
          ),
        ))
        .limit(PRUNE_BATCH_SIZE);

      if (rows.length === 0) break;
      await tx.delete(kbArticleChunks).where(
        inArray(kbArticleChunks.id, rows.map((r) => r.id)),
      );
      pruned += rows.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }

    return pruned;
  }

  private async prunePageChunksForOrg(tx: TenantTx, orgId: string): Promise<number> {
    let pruned = 0;

    for (;;) {
      const rows = await tx
        .select({ id: kbArticleChunks.id })
        .from(kbArticleChunks)
        .leftJoin(kbPages, and(
          eq(kbPages.id, kbArticleChunks.pageId),
          eq(kbPages.orgId, orgId),
        ))
        .where(and(
          eq(kbArticleChunks.orgId, orgId),
          isNotNull(kbArticleChunks.pageId),
          or(
            isNull(kbPages.id),
            eq(kbPages.status, "archived"),
            isNotNull(kbPages.deletedAt),
          ),
        ))
        .limit(PRUNE_BATCH_SIZE);

      if (rows.length === 0) break;
      await tx.delete(kbArticleChunks).where(
        inArray(kbArticleChunks.id, rows.map((r) => r.id)),
      );
      pruned += rows.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }

    return pruned;
  }
}
