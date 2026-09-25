import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { kbLinkedDocuments } from "../../../db/schema";
import type { TenantTx } from "../../../common/tenant";

export const SOURCE_REMOVED_GRACE_DAYS = 30;

export interface PurgeResult {
  purged: number;
  linkedDocumentIds: number[];
  truncated: boolean;
}

export async function purgeSourceRemovedLinks(tx: TenantTx, orgId: string, now: Date, batchSize: number): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - SOURCE_REMOVED_GRACE_DAYS * 24 * 3600 * 1000);
  const due = await tx
    .select({ id: kbLinkedDocuments.id })
    .from(kbLinkedDocuments)
    .where(and(eq(kbLinkedDocuments.orgId, orgId), or(and(eq(kbLinkedDocuments.status, "source_removed"), lt(kbLinkedDocuments.sourceRemovedAt, cutoff)), isNull(kbLinkedDocuments.documentId))))
    .orderBy(kbLinkedDocuments.id)
    .limit(batchSize);
  if (due.length === 0) return { purged: 0, linkedDocumentIds: [], truncated: false };

  const deleted = await tx
    .delete(kbLinkedDocuments)
    .where(and(eq(kbLinkedDocuments.orgId, orgId), inArray(kbLinkedDocuments.id, due.map((row) => row.id)), or(and(eq(kbLinkedDocuments.status, "source_removed"), sql`${kbLinkedDocuments.sourceRemovedAt} < ${cutoff.toISOString()}::timestamptz`), isNull(kbLinkedDocuments.documentId))))
    .returning({ id: kbLinkedDocuments.id });
  return { purged: deleted.length, linkedDocumentIds: deleted.map((row) => row.id), truncated: due.length === batchSize };
}
