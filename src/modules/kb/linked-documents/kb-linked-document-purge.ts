import { and, eq, inArray, lt, sql } from "drizzle-orm";
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
 * Deletes, for one organisation, the entries whose HR document has been gone for the grace period. Readers stopped
 * seeing them the moment the document was removed; this only clears what publishers were shown for a while. An
 * entry's audience rows go with it (cascade). Bounded per call, so an organisation with a large backlog is drained
 * over several runs rather than holding one transaction open. Runs inside the caller's tenant transaction.
 */
export async function purgeSourceRemovedLinks(tx: TenantTx, orgId: string, now: Date, batchSize: number): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - SOURCE_REMOVED_GRACE_DAYS * 24 * 3600 * 1000);
  const due = await tx
    .select({ id: kbLinkedDocuments.id })
    .from(kbLinkedDocuments)
    .where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.status, "source_removed"), lt(kbLinkedDocuments.sourceRemovedAt, cutoff)))
    .orderBy(kbLinkedDocuments.id)
    .limit(batchSize);
  if (due.length === 0) return { purged: 0, linkedDocumentIds: [], truncated: false };

  const deleted = await tx
    .delete(kbLinkedDocuments)
    // Re-stated on the delete: an entry brought back to life between the read and the delete is not `source_removed` any more and must survive.
    .where(and(eq(kbLinkedDocuments.orgId, orgId), inArray(kbLinkedDocuments.id, due.map((row) => row.id)), eq(kbLinkedDocuments.status, "source_removed"), sql`${kbLinkedDocuments.sourceRemovedAt} < ${cutoff.toISOString()}::timestamptz`))
    .returning({ id: kbLinkedDocuments.id });
  return { purged: deleted.length, linkedDocumentIds: deleted.map((row) => row.id), truncated: due.length === batchSize };
}
