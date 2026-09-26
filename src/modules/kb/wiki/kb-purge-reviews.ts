import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { kbPageReviews } from "../../../db/schema/kb/governance";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export async function purgeReviewsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageReviews)
        .where(
          and(
            eq(kbPageReviews.orgId, orgId),
            inArray(kbPageReviews.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}
