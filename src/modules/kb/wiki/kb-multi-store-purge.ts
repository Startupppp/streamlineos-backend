import { and, eq, inArray, isNull, min, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  kbPagePurgeLedger,
  KB_PURGE_STORES,
  type KbPurgeStore,
} from "../../../db/schema/kb/purge-ledger";
import {
  kbPageFavorites,
  kbPageLinks,
  kbPageVisits,
} from "../../../db/schema/kb/pages";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

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
  await runInNewTenantTransaction(db, orgId, async (tx) => {
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
  });
}

export async function isStoreComplete(
  db: Db,
  orgId: string,
  pageId: number,
  store: KbPurgeStore,
): Promise<boolean> {
  const row = await db.query.kbPagePurgeLedger.findFirst({
    where: and(
      eq(kbPagePurgeLedger.orgId, orgId),
      eq(kbPagePurgeLedger.pageId, pageId),
      eq(kbPagePurgeLedger.store, store),
    ),
    columns: { status: true },
  });
  return row?.status === "completed";
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
    );
  return rows.length > 0 && rows.every((r) => r.status === "completed");
}

export async function markStoreComplete(
  db: Db,
  orgId: string,
  pageId: number,
  store: KbPurgeStore,
): Promise<void> {
  await runInNewTenantTransaction(db, orgId, async (tx) => {
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
          eq(kbPagePurgeLedger.pageId, pageId),
          eq(kbPagePurgeLedger.store, store),
        ),
      );
  });
}

export async function markStoreFailed(
  db: Db,
  orgId: string,
  pageId: number,
  store: KbPurgeStore,
  reason: string,
): Promise<void> {
  await runInNewTenantTransaction(db, orgId, async (tx) => {
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
          eq(kbPagePurgeLedger.pageId, pageId),
          eq(kbPagePurgeLedger.store, store),
        ),
      );
  });
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
  await runInNewTenantTransaction(db, orgId, async (tx) => {
    await tx
      .delete(kbPageVisits)
      .where(
        and(
          eq(kbPageVisits.orgId, orgId),
          inArray(kbPageVisits.pageId, pageIds),
        ),
      );
  });
}

export async function purgeFavoritesForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInNewTenantTransaction(db, orgId, async (tx) => {
    await tx
      .delete(kbPageFavorites)
      .where(
        and(
          eq(kbPageFavorites.orgId, orgId),
          inArray(kbPageFavorites.pageId, pageIds),
        ),
      );
  });
}

export async function purgeLinksForPages(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<void> {
  if (pageIds.length === 0) return;
  await runInNewTenantTransaction(db, orgId, async (tx) => {
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
  });
}
