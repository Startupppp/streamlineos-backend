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

@Injectable()
export class CrmImportCommitService {
  private readonly logger = new Logger("CrmImport");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflows: WorkflowRunnerService,
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
    const [row] = await tx
      .update(crmImportRows)
      .set({ committedAt: new Date() })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
          isNull(crmImportRows.committedAt),
        ),
      )
      .returning();

    if (!row) return null;
    if (row.action === "skip") return "skipped";
    if (row.action === "merge") return "merged";

    if (row.action === "review") {
      await this.fileUncertainty(tx, organizationId, crmImportId, row, context.filename);
      return "review";
    }

    const writer = writerFor(context.entity);
    const planned = { values: row.values ?? {}, customFields: row.customFields ?? null };

    if (row.action === "create") {
      const recordId = await writer.create(tx, context.write, planned);

      await tx
        .update(crmImportRows)
        .set({ createdRecordId: recordId })
        .where(
          and(
            eq(crmImportRows.organizationId, organizationId),
            eq(crmImportRows.crmImportRowId, rowId),
          ),
        );

      return "created";
    }

    if (!row.matchedRecordId) throw new Error("an update row with nothing to update");

    const updates = writer.updates;
    if (!updates)
      throw new Error(`a ${context.entity} import cannot update an existing record`);

    const before = await updates.before(tx, context.write, row.matchedRecordId);
    if (!before) throw new Error("the matched record no longer exists");

    await updates.fillGaps(tx, context.write, row.matchedRecordId, before, planned);

    await tx
      .update(crmImportRows)
      .set({ previous: before })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
        ),
      );

    return "updated";
  }

  private async fileUncertainty(
    tx: TenantTx,
    organizationId: string,
    crmImportId: string,
    row: typeof crmImportRows.$inferSelect,
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
}
