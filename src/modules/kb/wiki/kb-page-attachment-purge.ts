import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { kbArticleAttachments, kbPageAttachments, kbPages } from "../../../db/schema";
import {
  storagePendingPurge,
  type StoragePurgeBucket,
} from "../../../db/schema/common/storage-pending-purge";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export const KB_PAGE_ATTACHMENT_PURGE_PURPOSE = "kb:page:purge";
export const KB_ARTICLE_ATTACHMENT_PURGE_PURPOSE = "support:kb-article:delete";
export const KB_ORPHAN_MEDIA_PURGE_PURPOSE = "kb:media-orphan:purge";

const PURGE_BOOKKEEPING_CHUNK = 500;
const ORPHAN_MEDIA_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

  const seen = new Set<string>();
  let afterId = 0;
  for (;;) {
    const batch = await db
      .select({ id: kbPageAttachments.id, fileKey: kbPageAttachments.fileKey })
      .from(kbPageAttachments)
      .where(
        and(
          eq(kbPageAttachments.orgId, orgId),
          inArray(kbPageAttachments.pageId, pageIds),
          gt(kbPageAttachments.id, afterId),
        ),
      )
      .orderBy(asc(kbPageAttachments.id))
      .limit(PURGE_BOOKKEEPING_CHUNK);
    for (const r of batch) seen.add(r.fileKey);
    const last = batch[batch.length - 1];
    if (batch.length < PURGE_BOOKKEEPING_CHUNK || last === undefined) break;
    afterId = last.id;
  }
  return openPurgeRecords(db, orgId, [...seen], KB_PAGE_ATTACHMENT_PURGE_PURPOSE, "kb");
}

/**
 * `kb_article_attachments` cascades away with its article through
 * `fk_kb_article_attachments_org_article`, exactly as the page table does, and
 * its objects live in the DEFAULT bucket because the client obtained the key
 * from `POST /storage/upload`, which writes with no override.
 */
export async function recordArticleAttachmentPurge(
  db: Db,
  orgId: string,
  articleIds: number[],
): Promise<string[]> {
  if (articleIds.length === 0) return [];

  const seen = new Set<string>();
  let afterId = 0;
  for (;;) {
    const batch = await db
      .select({ id: kbArticleAttachments.id, fileKey: kbArticleAttachments.fileKey })
      .from(kbArticleAttachments)
      .where(
        and(
          eq(kbArticleAttachments.orgId, orgId),
          inArray(kbArticleAttachments.articleId, articleIds),
          gt(kbArticleAttachments.id, afterId),
        ),
      )
      .orderBy(asc(kbArticleAttachments.id))
      .limit(PURGE_BOOKKEEPING_CHUNK);
    for (const r of batch) if (r.fileKey.trim().length > 0) seen.add(r.fileKey);
    const last = batch[batch.length - 1];
    if (batch.length < PURGE_BOOKKEEPING_CHUNK || last === undefined) break;
    afterId = last.id;
  }

  return openPurgeRecords(db, orgId, [...seen], KB_ARTICLE_ATTACHMENT_PURGE_PURPOSE, "default");
}

/**
 * `bucket` is written explicitly rather than left for the sweep to infer from
 * `purpose`: the purpose map is a fallback for rows that predate the column, and
 * a second producer of the same purpose would silently redirect every one of
 * these deletes at the wrong bucket, where an absent key answers SUCCESS.
 */
async function openPurgeRecords(
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
            orgId,
            storageKey,
            purpose,
            bucket,
            status: "pending",
          })),
        )
        .onConflictDoUpdate({
          target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
          set: { status: "pending", bucket, lastAttemptedAt: null, failedReason: null },
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

/**
 * A `page_id IS NULL` attachment row is reachable by no other purge path — the
 * page cascade selects by page id and nothing else ever touches the table — yet
 * the row is not automatically debris: the cover picker uploads with no page id
 * and stores the returned key in `kb_pages.cover_image`, so a live cover is a
 * page-less row. Anything a page still names is therefore excluded, trashed
 * pages included, because a restore must find its cover intact.
 */
export async function purgeOrphanedKbMedia(
  db: Db,
  storage: PageAttachmentObjectStore,
  orgId: string,
  now: Date,
  kbBucket: string | undefined,
): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_MEDIA_MIN_AGE_MS);
  let purged = 0;
  let afterId = 0;
  for (;;) {
    const batch = await db
      .select({ id: kbPageAttachments.id, fileKey: kbPageAttachments.fileKey })
      .from(kbPageAttachments)
      .where(
        and(
          eq(kbPageAttachments.orgId, orgId),
          isNull(kbPageAttachments.pageId),
          isNull(kbPageAttachments.deletedAt),
          lt(kbPageAttachments.createdAt, cutoff),
          gt(kbPageAttachments.id, afterId),
        ),
      )
      .orderBy(asc(kbPageAttachments.id))
      .limit(PURGE_BOOKKEEPING_CHUNK);

    const last = batch[batch.length - 1];
    if (last === undefined) break;
    afterId = last.id;

    const referenced = await coverImageKeys(
      db,
      orgId,
      batch.map((r) => r.fileKey),
    );
    const orphans = batch.filter((r) => !referenced.has(r.fileKey));
    if (orphans.length > 0) {
      const keys = await openPurgeRecords(
        db,
        orgId,
        [...new Set(orphans.map((r) => r.fileKey))],
        KB_ORPHAN_MEDIA_PURGE_PURPOSE,
        "kb",
      );
      const ids = orphans.map((r) => r.id);
      await runInNewTenantTransaction(db, orgId, async (tx) => {
        await tx
          .update(kbPageAttachments)
          .set({ deletedAt: now })
          .where(
            and(eq(kbPageAttachments.orgId, orgId), inArray(kbPageAttachments.id, ids)),
          );
      });
      await attemptPageAttachmentPurge(db, storage, orgId, keys, kbBucket);
      purged += ids.length;
    }

    if (batch.length < PURGE_BOOKKEEPING_CHUNK) break;
  }

  return purged;
}

async function coverImageKeys(
  db: Db,
  orgId: string,
  keys: string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  // The reposition control appends a `#y=NN` fragment to the stored key.
  const coverKey = sql<string>`split_part(${kbPages.coverImage}, '#', 1)`;
  const rows = await db
    .select({ coverKey })
    .from(kbPages)
    .where(and(eq(kbPages.orgId, orgId), inArray(coverKey, keys)))
    .limit(PURGE_BOOKKEEPING_CHUNK);
  return new Set(rows.map((r) => r.coverKey));
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
