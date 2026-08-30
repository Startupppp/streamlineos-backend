import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmImportRows, crmImports, workflowRuns } from "../../../db/schema";
import { CrmImportPreviewService } from "./crm-import-preview.service";
import { CrmImportCommitService } from "./crm-import-commit.service";
import { CrmImportRevertService } from "./crm-import-revert.service";

export type { BatchOutcome, PhaseExtent, ImportProgress } from "./crm-import-internals";
export { REVERT_WINDOW_DAYS } from "./crm-import-internals";
export { MAX_ROWS } from "./crm-import-preview.service";

@Injectable()
export class CrmImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly previewSvc: CrmImportPreviewService,
    private readonly commitSvc: CrmImportCommitService,
    private readonly revertSvc: CrmImportRevertService,
  ) {}

  preview(input: Parameters<CrmImportPreviewService["preview"]>[0]) {
    return this.previewSvc.preview(input);
  }

  getImport(organizationId: string, crmImportId: string) {
    return this.previewSvc.getImport(organizationId, crmImportId);
  }

  targetEntityOf(organizationId: string, crmImportId: string) {
    return this.previewSvc.targetEntityOf(organizationId, crmImportId);
  }

  startCommit(organizationId: string, crmImportId: string) {
    return this.commitSvc.startCommit(organizationId, crmImportId);
  }

  beginCommit(organizationId: string, crmImportId: string) {
    return this.commitSvc.beginCommit(organizationId, crmImportId);
  }

  commitBatch(
    organizationId: string,
    crmImportId: string,
    window: { fromRow: number; toRow: number },
  ) {
    return this.commitSvc.commitBatch(organizationId, crmImportId, window);
  }

  finishCommit(organizationId: string, crmImportId: string) {
    return this.commitSvc.finishCommit(organizationId, crmImportId);
  }

  startRevert(organizationId: string, userId: string, crmImportId: string) {
    return this.revertSvc.startRevert(organizationId, userId, crmImportId);
  }

  beginRevert(organizationId: string, crmImportId: string) {
    return this.revertSvc.beginRevert(organizationId, crmImportId);
  }

  revertBatch(
    organizationId: string,
    crmImportId: string,
    window: { fromRow: number; toRow: number },
  ) {
    return this.revertSvc.revertBatch(organizationId, crmImportId, window);
  }

  finishRevert(organizationId: string, crmImportId: string, userId: string) {
    return this.revertSvc.finishRevert(organizationId, crmImportId, userId);
  }

  async progress(organizationId: string, crmImportId: string) {
    const [imported] = await this.db
      .select({
        status: crmImports.status,
        workflowRunId: crmImports.workflowRunId,
        revertWorkflowRunId: crmImports.revertWorkflowRunId,
        revertDeadlineAt: crmImports.revertDeadlineAt,
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

    const undoing = imported.status === "reverting" || imported.status === "reverted";

    const [counts] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${crmImportRows.committedAt} is not null)::int`,
        reverted: sql<number>`count(*) filter (where ${crmImportRows.revertedAt} is not null)::int`,
        created: sql<number>`count(*) filter (where ${crmImportRows.createdRecordId} is not null)::int`,
        updated: sql<number>`count(*) filter (where ${crmImportRows.previous} is not null)::int`,
        review: sql<number>`count(*) filter (where ${crmImportRows.dataQualityFindingId} is not null)::int`,
        merged: sql<number>`count(*) filter (where ${crmImportRows.action} = 'merge' and ${crmImportRows.committedAt} is not null and ${crmImportRows.error} is null)::int`,
        skipped: sql<number>`count(*) filter (where ${crmImportRows.action} = 'skip' and ${crmImportRows.committedAt} is not null and ${crmImportRows.error} is null)::int`,
        failed: sql<number>`count(*) filter (where ${crmImportRows.error} is not null)::int`,
      })
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
        ),
      );

    const tally = counts ?? {
      total: 0,
      done: 0,
      reverted: 0,
      created: 0,
      updated: 0,
      review: 0,
      merged: 0,
      skipped: 0,
      failed: 0,
    };

    const workflowRunId = undoing ? imported.revertWorkflowRunId : imported.workflowRunId;
    const [run] = workflowRunId
      ? await this.db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.organizationId, organizationId),
              eq(workflowRuns.workflowRunId, workflowRunId),
            ),
          )
          .limit(1)
      : [];

    return {
      crmImportId,
      status: imported.status,
      workflowRunId,
      runStatus: run?.status ?? null,
      complete:
        imported.status === "committed" ||
        imported.status === "reverted" ||
        imported.status === "failed",
      total: tally.total,
      remaining: undoing ? tally.done - tally.reverted : tally.total - tally.done,
      created: tally.created,
      updated: tally.updated,
      merged: tally.merged,
      review: tally.review,
      skipped: tally.skipped,
      failed: tally.failed,
      reverted: tally.reverted,
      revertDeadlineAt: imported.revertDeadlineAt,
    };
  }
}
