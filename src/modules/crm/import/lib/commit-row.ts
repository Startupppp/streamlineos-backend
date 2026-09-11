import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../../../../db/drizzle.types";
import { crmImportRows, dataQualityFindings } from "../../../../db/schema";
import type { BatchOutcome, ImportContext } from "../crm-import-internals";
import { writerFor } from "../writers";
import { uncertaintyFinding } from "../import-uncertainty";

/**
 * Committing one import row, inside the savepoint `commitBatch` opens for it.
 *
 * Split out of `crm-import-commit.service.ts`, which keeps the phase around
 * it: claiming the import, walking the window, tallying and finishing. Every
 * statement here runs on the `tx` it is handed and never on the request's
 * `db`, so the claim, the write and the stamp commit or roll back together;
 * when they roll back, `commitBatch` records the failure on the row itself.
 *
 * Free functions rather than a second `@Injectable`: nothing here reaches a
 * service, so the DI graph and every caller stay as they were.
 */
export async function commitRow(
  tx: TenantTx,
  organizationId: string,
  crmImportId: string,
  rowId: string,
  context: ImportContext,
): Promise<keyof BatchOutcome | null> {
  /**
   * Claim first, and in this savepoint — by locking the row, not by stamping it.
   *
   * `committed_at IS NULL` is the whole idempotence guarantee: a re-run step
   * and a concurrent second run both find nothing to claim and do nothing.
   * `FOR UPDATE` is what makes that safe rather than racy — Postgres takes the
   * row lock, a second claimer blocks until this savepoint's transaction
   * resolves, and then re-evaluates the predicate against the committed truth
   * rather than its own stale snapshot.
   *
   * This used to be an `UPDATE ... SET committed_at = now() ... RETURNING`,
   * which took the same lock and also marked the row done before it had done
   * anything. `chk_crm_import_rows_outcome` exists to say a committed row
   * records what it did, so it can be undone — and a `create` row stamped
   * before `created_record_id` is written fails that check on the claim
   * itself. A CHECK constraint cannot be deferred, so every `create`, `update`
   * and `review` row failed on its first statement. So `committed_at` is now
   * stamped by `stamp` below, in the same statement as the column that says
   * what the row did.
   */
  const [row] = await tx
    // Named rather than `select()`: the eight below are what `commitRow` and
    // `fileUncertainty` between them read. `values` and `custom_fields` are
    // jsonb and can be the width of a spreadsheet row, so the columns this
    // does not name are not free.
    .select({
      crmImportRowId: crmImportRows.crmImportRowId,
      rowNumber: crmImportRows.rowNumber,
      action: crmImportRows.action,
      reason: crmImportRows.reason,
      values: crmImportRows.values,
      customFields: crmImportRows.customFields,
      matchedRecordId: crmImportRows.matchedRecordId,
      match: crmImportRows.match,
    })
    .from(crmImportRows)
    .where(
      and(
        eq(crmImportRows.organizationId, organizationId),
        eq(crmImportRows.crmImportRowId, rowId),
        isNull(crmImportRows.committedAt),
      ),
    )
    .limit(1)
    .for("update");

  // Somebody else has this row. Not an error, and not counted twice.
  if (!row) return null;

  /** Done, and what it did, together — which is what the CHECK asks for. */
  const stamp = async (outcome: Partial<typeof crmImportRows.$inferInsert> = {}) => {
    await tx
      .update(crmImportRows)
      .set({ ...outcome, committedAt: new Date() })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
        ),
      );
  };

  if (row.action === "skip") {
    await stamp();
    return "skipped";
  }

  // Its values were folded into the row it repeats while the plan was made,
  // so there is nothing left for it to write.
  if (row.action === "merge") {
    await stamp();
    return "merged";
  }

  if (row.action === "review") {
    // Writes `data_quality_finding_id` itself, so the row satisfies the CHECK
    // by the time it is stamped.
    await fileUncertainty(tx, organizationId, crmImportId, row, context.filename);
    await stamp();
    return "review";
  }

  const writer = writerFor(context.entity);
  const planned = { values: row.values ?? {}, customFields: row.customFields ?? null };

  if (row.action === "create") {
    const recordId = await writer.create(tx, context.write, planned);
    await stamp({ createdRecordId: recordId });
    return "created";
  }

  if (!row.matchedRecordId) throw new Error("an update row with nothing to update");

  const updates = writer.updates;
  if (!updates)
    throw new Error(`a ${context.entity} import cannot update an existing record`);

  const before = await updates.before(tx, context.write, row.matchedRecordId);
  if (!before) throw new Error("the matched record no longer exists");

  await updates.fillGaps(tx, context.write, row.matchedRecordId, before, planned);
  await stamp({ previous: before });

  return "updated";
}

async function fileUncertainty(
  tx: TenantTx,
  organizationId: string,
  crmImportId: string,
  /** The six columns this reads, so the claim in `commitRow` can name them. */
  row: Pick<
    typeof crmImportRows.$inferSelect,
    "crmImportRowId" | "rowNumber" | "reason" | "values" | "matchedRecordId" | "match"
  >,
  filename: string | null,
): Promise<void> {
  if (!row.matchedRecordId || !row.match)
    throw new Error("a review row with nothing recorded about why");

  const finding = uncertaintyFinding({
    crmImportId,
    rowNumber: row.rowNumber,
    matchedPartyId: row.matchedRecordId,
    match: row.match,
    values: row.values ?? {},
    reason: row.reason,
    sourceFilename: filename,
  });

  const now = new Date();
  const [filed] = await tx
    .insert(dataQualityFindings)
    .values({ organizationId, ...finding, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [
        dataQualityFindings.organizationId,
        dataQualityFindings.producer,
        dataQualityFindings.findingKind,
        dataQualityFindings.subjectKey,
      ],
      targetWhere: sql`status = 'open'`,
      set: {
        lastSeenAt: now,
        severity: sql`excluded.severity`,
        groupKey: sql`excluded.group_key`,
        evidence: sql`excluded.evidence`,
        score: sql`excluded.score`,
        proposedAction: sql`excluded.proposed_action`,
        reversibility: sql`excluded.reversibility`,
      },
    })
    .returning({ findingId: dataQualityFindings.findingId });

  if (!filed) throw new Error("the data-quality queue accepted nothing for this row");

  await tx
    .update(crmImportRows)
    .set({ dataQualityFindingId: filed.findingId })
    .where(
      and(
        eq(crmImportRows.organizationId, organizationId),
        eq(crmImportRows.crmImportRowId, row.crmImportRowId),
      ),
    );
}
