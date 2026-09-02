import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { gdprExportJobs } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import type { SubjectFileKey } from "../storage/storage-key-catalog";

export const EXPORT_ARTIFACT_PAGE = 200;

/** Drains every page rather than capping: a bare page reports a partial purge as complete. */
async function drain<T extends { id: string }>(
  page: (cursor: string | null) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await page(cursor);
    all.push(...rows);
    if (rows.length < EXPORT_ARTIFACT_PAGE) return all;
    const last = rows[rows.length - 1];
    if (!last || last.id === cursor) return all;
    cursor = last.id;
  }
}

/**
 * The subject's own export archives — the object-storage keys the file-key catalog
 * cannot attribute to them.
 *
 * `collectSubjectFileKeysWithLegalHold` finds a subject's objects only through a real
 * foreign key to `public.users`. `gdpr_export_jobs.subject_user_id` is a bare `text`
 * column with no constraint, so the table was classified org-scoped — and
 * `purgeFromManifest` skips org-scoped keys by design, to avoid destroying a third
 * party's object. The consequence was that erasing a subject left a complete JSON dump
 * of their personal data alive in the bucket, indefinitely.
 *
 * Read before the erasure transaction: a retired row that no longer names its object
 * cannot have that object found again.
 */
export async function collectSubjectExportArtifactKeys(
  db: Db,
  subject: { orgId: string; subjectUserId: string },
): Promise<SubjectFileKey[]> {
  const { orgId, subjectUserId } = subject;

  const artifacts = await drain((cursor) =>
    db
      .select({ id: gdprExportJobs.id, fileKey: gdprExportJobs.fileKey })
      .from(gdprExportJobs)
      .where(
        and(
          eq(gdprExportJobs.orgId, orgId),
          eq(gdprExportJobs.subjectUserId, subjectUserId),
          isNotNull(gdprExportJobs.fileKey),
          ...(cursor === null ? [] : [gt(gdprExportJobs.id, cursor)]),
        ),
      )
      .orderBy(asc(gdprExportJobs.id))
      .limit(EXPORT_ARTIFACT_PAGE),
  );

  const keys: SubjectFileKey[] = [];
  for (const row of artifacts)
    if (row.fileKey)
      keys.push({
        key: row.fileKey,
        table: "public.gdpr_export_jobs",
        column: "file_key",
        source: "user-fk",
        orgId,
      });
  return keys;
}

/**
 * Retires those jobs inside the erasure transaction.
 *
 * `file_key` is deliberately kept. The object is deleted after the commit, and a delete
 * that fails leaves a row that is `expired` and already past `expires_at` — downloadable
 * by nobody — while still naming its object, which is exactly the predicate
 * `CronGdprExportRetentionService` retries hourly. Nulling the key here would leave the
 * archive unreachable and permanent.
 */
export async function retireSubjectExportArtifacts(
  tx: TenantTx,
  subject: { orgId: string; subjectUserId: string },
): Promise<number> {
  const now = new Date();
  const rows = await tx
    .update(gdprExportJobs)
    .set({ status: "expired", fileName: null, expiresAt: now, updatedAt: now })
    .where(
      and(
        eq(gdprExportJobs.orgId, subject.orgId),
        eq(gdprExportJobs.subjectUserId, subject.subjectUserId),
        isNotNull(gdprExportJobs.fileKey),
      ),
    )
    .returning({ id: gdprExportJobs.id });
  return rows.length;
}
