import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmImportRows, crmImports } from "../../../db/schema";
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
import type { BatchOutcome, PhaseExtent } from "./crm-import-internals";
import { commitRow } from "./lib/commit-row";

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
          commitRow(tx, organizationId, crmImportId, row.crmImportRowId, context),
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
}
