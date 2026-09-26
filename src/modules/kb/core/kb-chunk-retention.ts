import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { kbArticleChunks, kbPages } from "../../../db/schema";
import type { TenantTx } from "../../../common/tenant";

export const CHUNK_RETENTION_BATCH_SIZE = 500;

export async function pruneStaleDocumentChunks(
  tx: TenantTx,
  orgId: string,
): Promise<number> {
  let pruned = 0;

  for (;;) {
    const rows = await tx
      .select({ id: kbArticleChunks.id })
      .from(kbArticleChunks)
      .leftJoin(
        kbPages,
        and(eq(kbPages.id, kbArticleChunks.pageId), eq(kbPages.orgId, orgId)),
      )
      .where(
        and(
          eq(kbArticleChunks.orgId, orgId),
          isNotNull(kbArticleChunks.pageId),
          or(
            isNull(kbPages.id),
            eq(kbPages.status, "archived"),
            isNotNull(kbPages.deletedAt),
          ),
        ),
      )
      .limit(CHUNK_RETENTION_BATCH_SIZE);

    if (rows.length === 0) break;
    await tx
      .delete(kbArticleChunks)
      .where(inArray(kbArticleChunks.id, rows.map((r) => r.id)));
    pruned += rows.length;
    if (rows.length < CHUNK_RETENTION_BATCH_SIZE) break;
  }

  return pruned;
}
