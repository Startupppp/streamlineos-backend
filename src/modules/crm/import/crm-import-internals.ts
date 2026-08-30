import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { crmImportRows, crmImports, workflowRuns } from "../../../db/schema";
import type { WorkflowRunnerService } from "../../../common/workflow";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { defaultPipelineId } from "./import-lookups";
import type { ImportEntity } from "./import-entities";
import type { ImportStatus } from "../../../db/schema/crm/imports";
import type { WriteContext } from "./writers";

/** Statuses a run is still going to do something about. */
export const LIVE_RUN_STATUSES = ["PENDING", "RUNNING", "SLEEPING"];

/**
 * How long an import stays reversible.
 *
 * Thirty days — same order as the notice a tenant gets for anything else
 * destructive, and long enough that "we imported the wrong file last month" is
 * still recoverable while short enough that before-images are not an indefinite
 * second copy of the CRM.
 */
export const REVERT_WINDOW_DAYS = 30;

/**
 * What `beginCommit` and `beginRevert` freeze for the life of a run.
 *
 * A type alias rather than an interface, and that is load-bearing: a step's
 * return value has to satisfy `JsonValue`, and TypeScript gives an object type
 * alias an implicit index signature while an interface gets none.
 */
export type PhaseExtent = {
  readonly settled: boolean;
  readonly total: number;
  readonly maxRowNumber: number;
};

/** What every row of one file has in common. Read once per batch. */
export interface ImportContext {
  readonly entity: ImportEntity;
  readonly filename: string | null;
  readonly write: WriteContext;
}

/** What one batch step did. Mutable: it is a tally. */
export type BatchOutcome = {
  created: number;
  updated: number;
  merged: number;
  review: number;
  skipped: number;
  failed: number;
};

export type ImportProgress = {
  readonly crmImportId: string;
  readonly status: ImportStatus;
  readonly workflowRunId: string | null;
  readonly runStatus: string | null;
  readonly complete: boolean;
  readonly total: number;
  readonly remaining: number;
  readonly created: number;
  readonly updated: number;
  readonly merged: number;
  readonly review: number;
  readonly skipped: number;
  readonly failed: number;
  readonly reverted: number;
  readonly revertDeadlineAt: Date | null;
};

export const NO_OUTCOME: BatchOutcome = {
  created: 0,
  updated: 0,
  merged: 0,
  review: 0,
  skipped: 0,
  failed: 0,
};

/** Options for the `startPhase` helper. */
export interface StartPhaseOptions {
  workflowName: string;
  existingRunId: string | null;
  input: Record<string, unknown>;
  column: "workflowRunId" | "revertWorkflowRunId";
}

export function inOwnTransaction<T>(
  db: Db,
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runInNewTenantTransaction(db, organizationId, () => fn());
}

export async function startPhase(
  db: Db,
  workflows: WorkflowRunnerService,
  organizationId: string,
  crmImportId: string,
  phase: StartPhaseOptions,
): Promise<string> {
  if (phase.existingRunId) {
    const [run] = await db
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, organizationId),
          eq(workflowRuns.workflowRunId, phase.existingRunId),
        ),
      )
      .limit(1);

    if (run && LIVE_RUN_STATUSES.includes(run.status)) return phase.existingRunId;
  }

  const runId = await workflows.start({
    organizationId,
    workflowName: phase.workflowName,
    input: phase.input,
    maxAttempts: 5,
  });

  if (!runId) throw new ConflictException("Could not start the import run.");

  await db
    .update(crmImports)
    .set({ [phase.column]: runId })
    .where(
      and(
        eq(crmImports.organizationId, organizationId),
        eq(crmImports.crmImportId, crmImportId),
      ),
    );

  return runId;
}

export async function loadExtentOf(
  db: Db,
  organizationId: string,
  crmImportId: string,
): Promise<PhaseExtent> {
  const [extent] = await db
    .select({
      total: sql<number>`count(*)::int`,
      maxRowNumber: sql<number>`coalesce(max(${crmImportRows.rowNumber}), 0)::int`,
    })
    .from(crmImportRows)
    .where(
      and(
        eq(crmImportRows.organizationId, organizationId),
        eq(crmImportRows.crmImportId, crmImportId),
      ),
    );

  return {
    settled: false,
    total: extent?.total ?? 0,
    maxRowNumber: extent?.maxRowNumber ?? 0,
  };
}

export async function loadImportContext(
  db: Db,
  organizationId: string,
  crmImportId: string,
): Promise<ImportContext> {
  const [imported] = await db
    .select({
      sourceFilename: crmImports.sourceFilename,
      targetEntity: crmImports.targetEntity,
      targetSubjectTypeId: crmImports.targetSubjectTypeId,
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

  const entity = imported.targetEntity;

  return {
    entity,
    filename: imported.sourceFilename,
    write: {
      organizationId,
      subjectTypeId: imported.targetSubjectTypeId,
      pipelineId: entity === "pipeline" ? await defaultPipelineId(db, organizationId) : null,
    },
  };
}
