import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { crmImportRows, crmImports, dataQualityFindings } from "../../../db/schema";
import { WorkflowRunnerService } from "../../../common/workflow";
import { REVERT_WORKFLOW } from "./import-workflow-names";
import {
  inOwnTransaction,
  loadExtentOf,
  loadImportContext,
  startPhase,
} from "./crm-import-internals";
import type { ImportContext, PhaseExtent } from "./crm-import-internals";
import { writerFor } from "./writers";

@Injectable()
export class CrmImportRevertService {
  private readonly logger = new Logger("CrmImport");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflows: WorkflowRunnerService,
  ) {}

  async startRevert(
    organizationId: string,
    userId: string,
    crmImportId: string,
  ): Promise<string> {
    return inOwnTransaction(this.db, organizationId, () =>
      this.claimForRevert(organizationId, userId, crmImportId),
    );
  }

  private async claimForRevert(
    organizationId: string,
    userId: string,
    crmImportId: string,
  ): Promise<string> {
    const [imported] = await this.db
      .select({
        status: crmImports.status,
        revertDeadlineAt: crmImports.revertDeadlineAt,
        revertWorkflowRunId: crmImports.revertWorkflowRunId,
      })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");
    if (imported.status !== "committed" && imported.status !== "reverting")
      throw new ConflictException("Only a committed import can be taken back.");

    if (imported.revertDeadlineAt && imported.revertDeadlineAt.getTime() < Date.now())
      throw new ConflictException(
        `This import stopped being reversible on ${imported.revertDeadlineAt.toISOString().slice(0, 10)}. ` +
          "The records it wrote are ordinary records now and can be edited or deleted individually.",
      );

    return startPhase(this.db, this.workflows, organizationId, crmImportId, {
      workflowName: REVERT_WORKFLOW,
      existingRunId: imported.revertWorkflowRunId,
      input: { crmImportId, userId },
      column: "revertWorkflowRunId",
    });
  }

  async beginRevert(organizationId: string, crmImportId: string): Promise<PhaseExtent> {
    const [imported] = await this.db
      .select({ status: crmImports.status, revertDeadlineAt: crmImports.revertDeadlineAt })
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
    if (imported.status !== "committed" && imported.status !== "reverting")
      return { settled: true, total: 0, maxRowNumber: 0 };

    if (imported.status === "committed")
      await this.db
        .update(crmImports)
        .set({ status: "reverting" })
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        );

    return loadExtentOf(this.db, organizationId, crmImportId);
  }

  async revertBatch(
    organizationId: string,
    crmImportId: string,
    window: { fromRow: number; toRow: number },
  ): Promise<{ deleted: number; restored: number; dismissed: number; failed: number }> {
    const rows = await this.db
      .select({ crmImportRowId: crmImportRows.crmImportRowId, rowNumber: crmImportRows.rowNumber })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          isNotNull(crmImportRows.committedAt),
          isNull(crmImportRows.revertedAt),
          gte(crmImportRows.rowNumber, window.fromRow),
          lte(crmImportRows.rowNumber, window.toRow),
        ),
      )
      .orderBy(desc(crmImportRows.rowNumber));

    const tally = { deleted: 0, restored: 0, dismissed: 0, failed: 0 };
    if (rows.length === 0) return tally;

    const context = await loadImportContext(this.db, organizationId, crmImportId);

    for (const row of rows) {
      try {
        const outcome = await this.db.transaction((tx) =>
          this.revertRow(tx, organizationId, row.crmImportRowId, context),
        );
        if (outcome) tally[outcome] += 1;
      } catch (error) {
        tally.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`revert ${crmImportId} row ${String(row.rowNumber)}: ${message}`);
        await this.db
          .update(crmImportRows)
          .set({ error: message, revertedAt: new Date() })
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

  async finishRevert(
    organizationId: string,
    crmImportId: string,
    userId: string,
  ): Promise<void> {
    await this.db
      .update(crmImports)
      .set({ status: "reverted", revertedAt: new Date(), revertedByUserId: userId })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
          eq(crmImports.status, "reverting"),
        ),
      );
  }

  private async revertRow(
    tx: TenantTx,
    organizationId: string,
    rowId: string,
    context: ImportContext,
  ): Promise<"deleted" | "restored" | "dismissed" | null> {
    const [row] = await tx
      .update(crmImportRows)
      .set({ revertedAt: new Date() })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
          isNotNull(crmImportRows.committedAt),
          isNull(crmImportRows.revertedAt),
        ),
      )
      .returning();

    if (!row) return null;

    const writer = writerFor(context.entity);

    if (row.createdRecordId) {
      await writer.remove(tx, context.write, row.createdRecordId);
      return "deleted";
    }

    if (row.previous && row.matchedRecordId) {
      const updates = writer.updates;
      if (!updates)
        throw new Error(`a ${context.entity} import has nothing to put a record back with`);

      await updates.restore(tx, context.write, row.matchedRecordId, row.previous);
      return "restored";
    }

    if (row.dataQualityFindingId) {
      await tx
        .update(dataQualityFindings)
        .set({ status: "dismissed", resolvedAt: new Date() })
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            eq(dataQualityFindings.findingId, row.dataQualityFindingId),
            eq(dataQualityFindings.status, "open"),
          ),
        );
      return "dismissed";
    }

    return null;
  }
}
