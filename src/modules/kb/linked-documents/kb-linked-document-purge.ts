import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { kbLinkedDocuments } from "../../../db/schema";
import type { TenantTx } from "../../../common/tenant";

/** How long an entry whose HR document was removed stays visible to publishers, as "Source removed", before it is deleted. */
export const SOURCE_REMOVED_GRACE_DAYS = 30;

export interface PurgeResult {
  purged: number;
  linkedDocumentIds: number[];
  /** True when a full batch was found, so more may be waiting for the next run. */
  truncated: boolean;
}

/**
 * Deletes, for one organisation, the entries whose HR document has been gone for the grace period, and the entries
 * whose document was deleted outright (the retention job, an import rollback): the foreign key can only null the
 * link's `document_id`, never change its status, so those are never `source_removed`, and there is no source left to
 * show a publisher, so they go at once. Readers stopped seeing both kinds the moment the document was removed; this
 * only clears what is left behind. An
 * entry's audience rows go with it (cascade). Bounded per call, so an organisation with a large backlog is drained
 * over several runs rather than holding one transaction open. Runs inside the caller's tenant transaction.
 */
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
    // Re-stated on the delete: an entry brought back to life between the read and the delete is not `source_removed` any more and must survive.
    .where(and(eq(kbLinkedDocuments.orgId, orgId), inArray(kbLinkedDocuments.id, due.map((row) => row.id)), or(and(eq(kbLinkedDocuments.status, "source_removed"), sql`${kbLinkedDocuments.sourceRemovedAt} < ${cutoff.toISOString()}::timestamptz`), isNull(kbLinkedDocuments.documentId))))
    .returning({ id: kbLinkedDocuments.id });
  return { purged: deleted.length, linkedDocumentIds: deleted.map((row) => row.id), truncated: due.length === batchSize };
}
