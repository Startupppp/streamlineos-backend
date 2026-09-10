import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { storagePendingPurge, type StoragePurgeBucket } from "../../../db/schema/common/storage-pending-purge";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export const PURGE_BOOKKEEPING_CHUNK = 500;

/**
 * Persist the object pointer before attachment rows can cascade away. The bucket
 * is explicit: inferring it from purpose can confirm a delete in the wrong bucket.
 * A separate tenant transaction keeps the pointer retryable after caller rollback.
 */
export async function openPurgeRecords(
  db: Db,
  orgId: string,
  keys: string[],
  purpose: string,
  bucket: StoragePurgeBucket,
): Promise<string[]> {
  if (keys.length === 0) return [];

  await runInNewTenantTransaction(db, orgId, async (tx) => {
    for (let i = 0; i < keys.length; i += PURGE_BOOKKEEPING_CHUNK)
      await tx
        .insert(storagePendingPurge)
        .values(
          keys.slice(i, i + PURGE_BOOKKEEPING_CHUNK).map((storageKey) => ({
            orgId, storageKey, purpose, bucket, status: "pending",
          })),
        )
        .onConflictDoUpdate({
          target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
          set: { status: "pending", bucket, lastAttemptedAt: null, failedReason: null },
        });
  });
  return keys;
}

interface PurgeMark {
  status: "confirmed" | "failed";
  confirmedAt?: Date;
  lastAttemptedAt: Date;
  failedReason: string | null;
}

/** Record each storage attempt without depending on a caller's ambient transaction. */
export async function markPurge(
  db: Db,
  orgId: string,
  storageKey: string,
  set: PurgeMark,
): Promise<void> {
  await runInNewTenantTransaction(db, orgId, async (tx) => {
    await tx
      .update(storagePendingPurge)
      .set({ ...set, attemptCount: sql`${storagePendingPurge.attemptCount} + 1` })
      .where(and(eq(storagePendingPurge.orgId, orgId), eq(storagePendingPurge.storageKey, storageKey)));
  });
}
