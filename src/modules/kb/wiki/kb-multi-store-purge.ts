import { and, eq, inArray, min, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  kbPagePurgeLedger,
  KB_PURGE_STORES,
  type KbPurgeStore,
} from "../../../db/schema/kb/purge-ledger";
import {
  kbPages,
  kbPageFavorites,
  kbPageLinks,
  kbPageVisits,
} from "../../../db/schema/kb/pages";
import type { CacheService } from "../../../common/cache/cache.service";
import {
  kbPageVersions,
  kbPageComments,
} from "../../../db/schema/kb/page-collab";
import { kbPageGrants } from "../../../db/schema/kb/page-grants";
import { kbArticleChunks } from "../../../db/schema/support/kb-chunks";
import { kbEvents } from "../../../db/schema/kb/events";
import { notifications } from "../../../db/schema/common/notifications";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export { KB_PURGE_STORES };
export type { KbPurgeStore };

export async function openMultiStoreLedger(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  const rows = pageIds.flatMap((pageId) =>
    KB_PURGE_STORES.map((store) => ({
      orgId,
      pageId,
      store,
      status: "pending" as const,
    })),
  );
  await runInTenantTransaction(
    db,
    async (tx) => {
      for (let i = 0; i < rows.length; i += 100) {
        await tx
          .insert(kbPagePurgeLedger)
          .values(rows.slice(i, i + 100))
          .onConflictDoNothing({
            target: [
              kbPagePurgeLedger.orgId,
              kbPagePurgeLedger.pageId,
              kbPagePurgeLedger.store,
            ],
          });
      }
    },
    { orgId },
  );
}

export async function incompleteStorePages(
  db: Db,
  orgId: string,
  pageIds: number[],
  store: KbPurgeStore,
): Promise<number[]> {
  if (pageIds.length === 0) return [];
  const completed = await db
    .select({ pageId: kbPagePurgeLedger.pageId })
    .from(kbPagePurgeLedger)
    .where(
      and(
        eq(kbPagePurgeLedger.orgId, orgId),
        inArray(kbPagePurgeLedger.pageId, pageIds),
        eq(kbPagePurgeLedger.store, store),
        eq(kbPagePurgeLedger.status, "completed"),
      ),
    )
    .limit(pageIds.length);
  const done = new Set(completed.map((row) => row.pageId));
  return pageIds.filter((pageId) => !done.has(pageId));
}

export async function areAllStoresComplete(
  db: Db,
  orgId: string,
  pageId: number,
): Promise<boolean> {
  const rows = await db
    .select({ status: kbPagePurgeLedger.status })
    .from(kbPagePurgeLedger)
    .where(
      and(
        eq(kbPagePurgeLedger.orgId, orgId),
        eq(kbPagePurgeLedger.pageId, pageId),
      ),
    )
    .limit(KB_PURGE_STORES.length);
  return rows.length > 0 && rows.every((r) => r.status === "completed");
}

export async function markStoresComplete(
  db: Db,
  orgId: string,
  pageIds: number[],
  store: KbPurgeStore,
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .update(kbPagePurgeLedger)
        .set({
          status: "completed",
          completedAt: new Date(),
          attemptCount: sql`${kbPagePurgeLedger.attemptCount} + 1`,
        })
        .where(
          and(
            eq(kbPagePurgeLedger.orgId, orgId),
            inArray(kbPagePurgeLedger.pageId, pageIds),
            eq(kbPagePurgeLedger.store, store),
          ),
        );
    },
    { orgId },
  );
}

export async function markStoresFailed(
  db: Db,
  orgId: string,
  pageIds: number[],
  store: KbPurgeStore,
  reason: string,
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .update(kbPagePurgeLedger)
        .set({
          status: "failed",
          failedReason: reason.slice(0, 1_000),
          attemptCount: sql`${kbPagePurgeLedger.attemptCount} + 1`,
        })
        .where(
          and(
            eq(kbPagePurgeLedger.orgId, orgId),
            inArray(kbPagePurgeLedger.pageId, pageIds),
            eq(kbPagePurgeLedger.store, store),
          ),
        );
    },
    { orgId },
  );
}

export async function oldestIncompleteLedgerEntry(
  db: Db,
): Promise<Date | null> {
  const [row] = await db
    .select({ oldest: min(kbPagePurgeLedger.createdAt) })
    .from(kbPagePurgeLedger)
    .where(eq(kbPagePurgeLedger.status, "pending"));
  return row?.oldest ?? null;
}

export async function purgeVisitsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageVisits)
        .where(
          and(
            eq(kbPageVisits.orgId, orgId),
            inArray(kbPageVisits.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeFavoritesForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageFavorites)
        .where(
          and(
            eq(kbPageFavorites.orgId, orgId),
            inArray(kbPageFavorites.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeLinksForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageLinks)
        .where(
          and(
            eq(kbPageLinks.orgId, orgId),
            inArray(kbPageLinks.sourcePageId, pageIds),
          ),
        );
      await tx
        .delete(kbPageLinks)
        .where(
          and(
            eq(kbPageLinks.orgId, orgId),
            inArray(kbPageLinks.targetPageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeVersionsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageVersions)
        .where(
          and(
            eq(kbPageVersions.orgId, orgId),
            inArray(kbPageVersions.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeCommentsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageComments)
        .where(
          and(
            eq(kbPageComments.orgId, orgId),
            inArray(kbPageComments.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeGrantsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbPageGrants)
        .where(
          and(
            eq(kbPageGrants.orgId, orgId),
            inArray(kbPageGrants.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeChunksForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(kbArticleChunks)
        .where(
          and(
            eq(kbArticleChunks.orgId, orgId),
            inArray(kbArticleChunks.pageId, pageIds),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeAnalyticsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .update(kbEvents)
        .set({ articleId: null })
        .where(
          and(eq(kbEvents.orgId, orgId), inArray(kbEvents.articleId, pageIds)),
        );
    },
    { orgId },
  );
}

export async function purgeNotificationsForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  const entityIds = pageIds.map(String);
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .delete(notifications)
        .where(
          and(
            eq(notifications.orgId, orgId),
            inArray(notifications.entityId, entityIds),
            inArray(notifications.entityType, ["kb_page", "kb_page_review"]),
          ),
        );
    },
    { orgId },
  );
}

export async function purgeCachesForPages(
  cache: CacheService,
  orgId: string,
  _pageIds: number[],
): Promise<void> {
  await cache.invalidateNamespace(`kb:acc-spaces:${orgId}`);
}

export async function purgePublicCdnForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInTenantTransaction(
    db,
    async (tx) => {
      await tx
        .update(kbPages)
        .set({ publicToken: null })
        .where(and(eq(kbPages.orgId, orgId), inArray(kbPages.id, pageIds)));
    },
    { orgId },
  );
}

export async function purgeConnectorProjectionsForPages(
  _db: Db,
  _orgId: string,
  _pageIds: number[],
): Promise<void> {
  return;
}
