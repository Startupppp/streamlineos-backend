import { sql } from "drizzle-orm";
import { drainPages } from "./drain";
import type { TenantTx } from "../../common/tenant";
import { documents, onboardingDocuments, documentAuditLogs } from "../../db/schema";

const NON_OBJECT_FILE_REFERENCES = new Set(["retention://redacted", ""]);

export interface DocumentRetentionOptions {
  readonly orgId: string;
  readonly cutoff: Date;
  readonly action: string;
  readonly batchSize: number;
  readonly maxBatches: number;
}

export interface DocumentRetentionOutcome {
  deleted: number;
  redacted: number;
  protected: number;
  scanned: number;
  truncated: boolean;
  retiredKeys: string[];
}

type DocumentRow = { id: number; fileUrl: string | null };

function collectRetiredKeys(
  into: string[],
  candidates: ReadonlyArray<DocumentRow>,
  affectedIds: ReadonlyArray<number>,
): void {
  const affected = new Set(affectedIds);
  for (const candidate of candidates) {
    if (!affected.has(candidate.id)) continue;
    const reference = candidate.fileUrl;
    if (!reference || NON_OBJECT_FILE_REFERENCES.has(reference)) continue;
    if (/^https?:\/\//i.test(reference)) continue;
    into.push(reference);
  }
}

function selectGenericDocuments(
  tx: TenantTx,
  orgId: string,
  cutoff: Date,
  batchSize: number,
): Promise<DocumentRow[]> {
  return tx
    .select({ id: documents.id, fileUrl: documents.fileUrl })
    .from(documents)
    .where(sql`${documents.orgId} = ${orgId}
        AND ${documents.createdAt} < ${cutoff}
        AND ${documents.fileUrl} <> 'retention://redacted'
        AND NOT EXISTS (
          SELECT 1 FROM hr_legal_hold_items hli
          WHERE hli.org_id = ${orgId}
            AND hli.item_type = 'document'
            AND hli.item_ref = ${documents.id}::text
            AND hli.locked = true
        )`)
    .limit(batchSize);
}

async function processGenericDocuments(
  tx: TenantTx,
  orgId: string,
  action: string,
  genericRows: DocumentRow[],
  retiredKeys: string[],
): Promise<{ deleted: number; redacted: number }> {
  const ids = sql.join(
    genericRows.map((row) => sql`${row.id}`),
    sql`, `,
  );
  if (action === "delete") {
    const rows = await tx
      .delete(documents)
      .where(sql`${documents.orgId} = ${orgId} AND ${documents.id} IN (${ids})`)
      .returning({ id: documents.id });
    collectRetiredKeys(retiredKeys, genericRows, rows.map((row) => row.id));
    return { deleted: rows.length, redacted: 0 };
  }
  if (action === "anonymize") {
    const rows = await tx
      .update(documents)
      .set({ fileUrl: "retention://redacted", fileName: "redacted", description: null, metadata: null })
      .where(sql`${documents.orgId} = ${orgId} AND ${documents.id} IN (${ids})`)
      .returning({ id: documents.id });
    collectRetiredKeys(retiredKeys, genericRows, rows.map((row) => row.id));
    return { deleted: 0, redacted: rows.length };
  }
  return { deleted: 0, redacted: 0 };
}

function selectOnboardingDocuments(
  tx: TenantTx,
  orgId: string,
  cutoff: Date,
  batchSize: number,
): Promise<DocumentRow[]> {
  return tx
    .select({ id: onboardingDocuments.id, fileUrl: onboardingDocuments.fileUrl })
    .from(onboardingDocuments)
    .where(sql`${onboardingDocuments.orgId} = ${orgId}
        AND ${onboardingDocuments.createdAt} < ${cutoff}
        AND ${onboardingDocuments.fileUrl} <> 'retention://redacted'
        AND NOT EXISTS (
          SELECT 1 FROM hr_legal_hold_items hli
          WHERE hli.org_id = ${orgId}
            AND hli.item_type = 'document'
            AND hli.item_ref = ${onboardingDocuments.id}::text
            AND hli.locked = true
        )`)
    .limit(batchSize);
}

/**
 * An onboarding document that has been read, downloaded or verified leaves a
 * `document_audit_logs` row; deleting it would break that trail, so it is redacted in
 * place while unaudited rows may be removed outright.
 */
async function processOnboardingDocuments(
  tx: TenantTx,
  orgId: string,
  action: string,
  onboardingRows: DocumentRow[],
  retiredKeys: string[],
): Promise<{ deleted: number; redacted: number; protected: number }> {
  const auditRows = await tx
    .select({ id: documentAuditLogs.onboardingDocumentId })
    .from(documentAuditLogs)
    .where(sql`${documentAuditLogs.orgId} = ${orgId}
        AND ${documentAuditLogs.onboardingDocumentId} IN (${sql.join(onboardingRows.map((row) => sql`${row.id}`), sql`, `)})`);
  const auditedIds = new Set(auditRows.map((row) => row.id));

  let deleted = 0;
  const deletableIds = onboardingRows.map((row) => row.id).filter((id) => !auditedIds.has(id));
  if (action === "delete" && deletableIds.length > 0) {
    const rows = await tx
      .delete(onboardingDocuments)
      .where(sql`${onboardingDocuments.orgId} = ${orgId} AND ${onboardingDocuments.id} IN (${sql.join(deletableIds.map((id) => sql`${id}`), sql`, `)})`)
      .returning({ id: onboardingDocuments.id });
    deleted = rows.length;
    collectRetiredKeys(retiredKeys, onboardingRows, rows.map((row) => row.id));
  }

  let redacted = 0;
  const redactIds = onboardingRows
    .map((row) => row.id)
    .filter((id) => auditedIds.has(id) || action === "anonymize");
  if (redactIds.length > 0) {
    const rows = await tx
      .update(onboardingDocuments)
      .set({ fileUrl: "retention://redacted", fileName: "redacted", remarks: null })
      .where(sql`${onboardingDocuments.orgId} = ${orgId} AND ${onboardingDocuments.id} IN (${sql.join(redactIds.map((id) => sql`${id}`), sql`, `)})`)
      .returning({ id: onboardingDocuments.id });
    redacted = rows.length;
    collectRetiredKeys(retiredKeys, onboardingRows, rows.map((row) => row.id));
  }

  // Only this table's own rows: the count used to subtract the generic table's
  // deletions too and could go negative.
  return { deleted, redacted, protected: onboardingRows.length - deleted - redacted };
}

/**
 * Drains BOTH document tables rather than taking one page of each per tick.
 *
 * `scanned` is the number of rows the predicate matched, so a run that scanned 200 and
 * processed 0 is visible: that is the stall shape a policy whose `action` is neither
 * "delete" nor "anonymize" produces, and a naive loop would spin on it for ever.
 *
 * Returns the object-storage keys whose rows were removed or redacted. They are deleted
 * after the transaction commits, never inside it — an object delete is a network call.
 */
export async function sweepRetentionDocuments(
  tx: TenantTx,
  { orgId, cutoff, action, batchSize, maxBatches }: DocumentRetentionOptions,
): Promise<DocumentRetentionOutcome> {
  const retiredKeys: string[] = [];
  let deleted = 0;
  let redacted = 0;
  let protectedCount = 0;

  const generic = await drainPages(batchSize, maxBatches, async () => {
    const rows = await selectGenericDocuments(tx, orgId, cutoff, batchSize);
    if (rows.length === 0) return { selected: 0, processed: 0 };
    const processed = await processGenericDocuments(tx, orgId, action, rows, retiredKeys);
    deleted += processed.deleted;
    redacted += processed.redacted;
    return { selected: rows.length, processed: processed.deleted + processed.redacted };
  });

  const onboarding = await drainPages(batchSize, maxBatches, async () => {
    const rows = await selectOnboardingDocuments(tx, orgId, cutoff, batchSize);
    if (rows.length === 0) return { selected: 0, processed: 0 };
    const processed = await processOnboardingDocuments(tx, orgId, action, rows, retiredKeys);
    deleted += processed.deleted;
    redacted += processed.redacted;
    protectedCount += processed.protected;
    return { selected: rows.length, processed: processed.deleted + processed.redacted };
  });

  return {
    deleted,
    redacted,
    protected: protectedCount,
    scanned: generic.scanned + onboarding.scanned,
    truncated: generic.truncated || onboarding.truncated,
    retiredKeys,
  };
}
