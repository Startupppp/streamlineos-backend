import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { kbPageAttachments } from "../../../db/schema";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export const KB_PAGE_ATTACHMENT_PURGE_PURPOSE = "kb:page:purge";

const PURGE_BOOKKEEPING_CHUNK = 500;

export interface PageAttachmentObjectStore {
  deleteFileIfPresent(
    orgId: string,
    key: string,
    bucketOverride?: string,
  ): Promise<boolean>;
}

/**
 * `kb_page_attachments` carries a composite (org_id, page_id) foreign key with
 * ON DELETE CASCADE, so deleting a page takes its attachment rows with it while
 * the R2 objects those rows name survive. Once the row is gone nothing records
 * that the object was ever ours, which is an orphan no later sweep can find —
 * the pointer existed only in the row that was just cascaded away.
 *
 * `storage_pending_purge` is that pointer, written BEFORE the page delete and
 * read back by the storage sweep. The ordering is the whole point: a crash, an
 * R2 outage or a rolled-back delete between the two leaves a retryable record
 * rather than a lost object.
 */
export async function recordPageAttachmentPurge(
  db: Db,
  orgId: string,
  pageIds: number[],
): Promise<string[]> {
  if (pageIds.length === 0) return [];

  const rows = await db
    .select({ fileKey: kbPageAttachments.fileKey })
    .from(kbPageAttachments)
    .where(and(eq(kbPageAttachments.orgId, orgId), inArray(kbPageAttachments.pageId, pageIds)));

  const keys = [...new Set(rows.map((r) => r.fileKey))];
  if (keys.length === 0) return [];

  await runInNewTenantTransaction(db, orgId, async (tx) => {
    for (let i = 0; i < keys.length; i += PURGE_BOOKKEEPING_CHUNK)
      await tx
        .insert(storagePendingPurge)
        .values(
          keys.slice(i, i + PURGE_BOOKKEEPING_CHUNK).map((storageKey) => ({
            orgId,
            storageKey,
            purpose: KB_PAGE_ATTACHMENT_PURGE_PURPOSE,
            status: "pending",
          })),
        )
        .onConflictDoUpdate({
          target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
          set: { status: "pending", lastAttemptedAt: null, failedReason: null },
        });
  });

  return keys;
}

/**
 * Best effort, and deliberately so: every key reaching here already has a
 * write-ahead row, so a failure is a retry for `CronStorageSweepService`, not a
 * lost object. It must never throw back into the caller, because the pages are
 * already deleted by the time it runs and an exception here would report a
 * completed purge as a failure.
 *
 * `kbBucket` is required rather than optional and mirrors the override
 * `KbMediaService` uploads these objects with. It is not decoration: an
 * S3-compatible delete of a key that is absent answers success, so a delete
 * that omitted the override would mark the row confirmed while the object sat
 * untouched in the KB bucket with nothing left pointing at it. `undefined` is a
 * legitimate value — it means the deployment runs a single bucket — but it has
 * to be passed deliberately, not forgotten.
 */
export async function attemptPageAttachmentPurge(
  db: Db,
  storage: PageAttachmentObjectStore,
  orgId: string,
  keys: string[],
  kbBucket: string | undefined,
): Promise<{ confirmed: number; failed: number }> {
  let confirmed = 0;
  let failed = 0;

  for (const storageKey of keys) {
    try {
      await storage.deleteFileIfPresent(orgId, storageKey, kbBucket);
    } catch (err) {
      failed += 1;
      await markPurge(db, orgId, storageKey, {
        status: "failed",
        failedReason: String(err).slice(0, 1_000),
        lastAttemptedAt: new Date(),
      }).catch(() => undefined);
      continue;
    }
    confirmed += 1;
    await markPurge(db, orgId, storageKey, {
      status: "confirmed",
      confirmedAt: new Date(),
      lastAttemptedAt: new Date(),
      failedReason: null,
    }).catch(() => undefined);
  }

  return { confirmed, failed };
}

interface PurgeMark {
  status: "confirmed" | "failed";
  confirmedAt?: Date;
  lastAttemptedAt: Date;
  failedReason: string | null;
}

async function markPurge(
  db: Db,
  orgId: string,
  storageKey: string,
  set: PurgeMark,
): Promise<void> {
  await runInNewTenantTransaction(db, orgId, async (tx) => {
    await tx
      .update(storagePendingPurge)
      .set({ ...set, attemptCount: sql`${storagePendingPurge.attemptCount} + 1` })
      .where(
        and(
          eq(storagePendingPurge.orgId, orgId),
          eq(storagePendingPurge.storageKey, storageKey),
        ),
      );
  });
}
