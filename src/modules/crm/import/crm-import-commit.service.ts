import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { crmImportRows, crmImports, dataQualityFindings } from "../../../db/schema";
import { WorkflowRunnerService } from "../../../common/workflow";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { COMMIT_WORKFLOW } from "./import-workflow-names";
import {
  inOwnTransaction,
  loadExtentOf,
  loadImportContext,
  NO_OUTCOME,
  REVERT_WINDOW_DAYS,
  startPhase,
} from "./crm-import-internals";
import type { BatchOutcome, ImportContext, PhaseExtent } from "./crm-import-internals";
import { writerFor } from "./writers";
import { uncertaintyFinding } from "./import-uncertainty";
import type { RowMatch } from "./import-plan";

@Injectable()
export class CrmImportCommitService {
  private readonly logger = new Logger("CrmImport");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflows: WorkflowRunnerService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async startCommit(organizationId: string, crmImportId: string): Promise<string> {
    return inOwnTransaction(this.db, organizationId, () =>
      this.claimForCommit(organizationId, crmImportId),
    );
  }

  private async claimForCommit(organizationId: string, crmImportId: string): Promise<string> {
    const [imported] = await this.db
      .select({ status: crmImports.status, workflowRunId: crmImports.workflowRunId })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");
    if (imported.status !== "previewing" && imported.status !== "committing")
      throw new ConflictException(`That import is already ${imported.status}.`);

    /*
      What the plan allows, asked once for the whole batch and before any row
      lands.

      An import is the easiest way to walk past a seat or record cap: it creates
      in bulk, from a file, with nobody watching. Asking per row would refuse
      halfway through and leave the tenant with a partial import, so the question
      is asked here -- against the rows still uncommitted, which is what a resumed
      commit would go on to create rather than what the file originally held.

      This guard existed before the importer moved to `crm/import/`; the move
      left it behind, and `party-creation-invariant.spec.ts` is what noticed.
    */
    const [creating] = await this.db
      .select({ rows: sql<number>`count(*)::int` })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          eq(crmImportRows.action, "create"),
          isNull(crmImportRows.committedAt),
        ),
      );

    if (creating && creating.rows > 0) {
      await this.planLimits.assertWithinLimit(organizationId, "crmContacts", creating.rows);
    }

    return startPhase(this.db, this.workflows, organizationId, crmImportId, {
      workflowName: COMMIT_WORKFLOW,
      existingRunId: imported.workflowRunId,
      input: { crmImportId },
      column: "workflowRunId",
    });
  }

  async beginCommit(organizationId: string, crmImportId: string): Promise<PhaseExtent> {
    const [imported] = await this.db
      .select({ status: crmImports.status })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1)
      .for("update");

    if (!imported) throw new NotFoundException("Import not found");

    if (imported.status !== "previewing" && imported.status !== "committing")
      return { settled: true, total: 0, maxRowNumber: 0 };

    if (imported.status === "previewing")
      await this.db
        .update(crmImports)
        .set({ status: "committing" })
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        );

    return loadExtentOf(this.db, organizationId, crmImportId);
  }

  async commitBatch(
    organizationId: string,
    crmImportId: string,
    window: { fromRow: number; toRow: number },
  ): Promise<BatchOutcome> {
    const rows = await this.db
      .select({ crmImportRowId: crmImportRows.crmImportRowId, rowNumber: crmImportRows.rowNumber })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          isNull(crmImportRows.committedAt),
          gte(crmImportRows.rowNumber, window.fromRow),
          lte(crmImportRows.rowNumber, window.toRow),
        ),
      )
      .orderBy(asc(crmImportRows.rowNumber));

    if (rows.length === 0) return NO_OUTCOME;

    const context = await loadImportContext(this.db, organizationId, crmImportId);
    const tally = { ...NO_OUTCOME };

    for (const row of rows) {
      try {
        const outcome = await this.db.transaction((tx) =>
          this.commitRow(tx, organizationId, crmImportId, row.crmImportRowId, context),
        );

        if (outcome) tally[outcome] += 1;
      } catch (error) {
        tally.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`import ${crmImportId} row ${String(row.rowNumber)}: ${message}`);
        await this.db
          .update(crmImportRows)
          .set({ error: message, committedAt: new Date() })
          .where(
            and(
              eq(crmImportRows.organizationId, organizationId),
              eq(crmImportRows.crmImportRowId, row.crmImportRowId),
            ),
          );
      }
    }

    return tally;
  }

  async finishCommit(organizationId: string, crmImportId: string): Promise<void> {
    const now = new Date();
    const deadline = new Date(now.getTime() + REVERT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    await this.db
      .update(crmImports)
      .set({ status: "committed", committedAt: now, revertDeadlineAt: deadline })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
          eq(crmImports.status, "committing"),
        ),
      );
  }

  private async commitRow(
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
      await this.fileUncertainty(tx, organizationId, crmImportId, row, context.filename);
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

  private async fileUncertainty(
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
      match: row.match as RowMatch,
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
}
