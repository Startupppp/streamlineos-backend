import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { storagePendingPurge } from "../../db/schema/common/storage-pending-purge";

export const PENDING_PURGE_MAX_ATTEMPTS = 10;

export interface PendingPurgeRow {
  id: string;
  storageKey: string;
  purpose: string;
  /**
   * The bucket role the producer recorded, or NULL where none did. NULL is not
   * `default`: `purpose` alone cannot resolve an `org-purge` row, which spans a
   * key from every table in the schema. The consumer refuses on it.
   */
  bucket: string | null;
}

/**
 * `storage_pending_purge` is the write-ahead record that an object was ours to
 * delete: the row is written before the delete is attempted, so a crash between
 * the two cannot lose the only pointer to the object. Two writers open rows on
 * it — the organization purge and e-sign document deletion — and until this
 * service existed nothing ever read one back, so a row parked at `failed` was a
 * permanent orphan rather than a retry.
 *
 * Every method takes the tenant explicitly. The two marks update a row that
 * DELETES an object, so binding `org_id` alongside the primary key is a third
 * guard beside the tenant-scoped read that produced the id and the RLS policy
 * on the table — and the only one that still holds outside a tenant transaction
 * or under a role with BYPASSRLS.
 */
@Injectable()
export class StoragePendingPurgeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listForRetry(orgId: string, limit: number): Promise<PendingPurgeRow[]> {
    return this.db
      .select({
        id: storagePendingPurge.id,
        storageKey: storagePendingPurge.storageKey,
        purpose: storagePendingPurge.purpose,
        bucket: storagePendingPurge.bucket,
      })
      .from(storagePendingPurge)
      .where(
        and(
          eq(storagePendingPurge.orgId, orgId),
          inArray(storagePendingPurge.status, ["pending", "failed"]),
          lt(storagePendingPurge.attemptCount, PENDING_PURGE_MAX_ATTEMPTS),
        ),
      )
      .orderBy(asc(storagePendingPurge.createdAt))
      .limit(limit);
  }

  async markConfirmed(orgId: string, id: string): Promise<void> {
    await this.db
      .update(storagePendingPurge)
      .set({
        status: "confirmed",
        confirmedAt: new Date(),
        lastAttemptedAt: new Date(),
        failedReason: null,
        attemptCount: sql`${storagePendingPurge.attemptCount} + 1`,
      })
      .where(and(eq(storagePendingPurge.id, id), eq(storagePendingPurge.orgId, orgId)));
  }

  async markFailed(orgId: string, id: string, reason: string): Promise<void> {
    await this.db
      .update(storagePendingPurge)
      .set({
        status: "failed",
        failedReason: reason.slice(0, 1_000),
        lastAttemptedAt: new Date(),
        attemptCount: sql`${storagePendingPurge.attemptCount} + 1`,
      })
      .where(and(eq(storagePendingPurge.id, id), eq(storagePendingPurge.orgId, orgId)));
  }
}
