import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { workflowRuns, workflowSteps } from "../../db/schema";

export interface InspectedStep {
  stepName: string;
  status: string;
  output: unknown;
  error: string | null;
  attempt: number;
  startedAt: Date;
  completedAt: Date | null;
}

export interface InspectedRun {
  workflowRunId: string;
  workflowName: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  attempt: number;
  maxAttempts: number;
  runAfter: Date;
  lastError: string | null;
  deadLetteredAt: Date | null;
  correlationId: string | null;
  causationEventId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  steps: InspectedStep[];
}

/**
 * Reads a run's history back.
 *
 * An autonomous system that cannot be asked what it did is not reviewable, and
 * the durable runtime is only useful if the record it leaves can be read: what
 * started the run, which steps ran, what each produced, and where it stopped.
 *
 * Every query is scoped to the organisation, and a run belonging to another
 * tenant reads as absent rather than forbidden — a 403 would confirm it exists.
 */
@Injectable()
export class WorkflowInspectorService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listRuns(
    organizationId: string,
    options: { status?: string; workflowName?: string; limit?: number } = {},
  ): Promise<Omit<InspectedRun, "steps">[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    return this.db
      .select({
        workflowRunId: workflowRuns.workflowRunId,
        workflowName: workflowRuns.workflowName,
        status: workflowRuns.status,
        input: workflowRuns.input,
        output: workflowRuns.output,
        attempt: workflowRuns.attempt,
        maxAttempts: workflowRuns.maxAttempts,
        runAfter: workflowRuns.runAfter,
        lastError: workflowRuns.lastError,
        deadLetteredAt: workflowRuns.deadLetteredAt,
        correlationId: workflowRuns.correlationId,
        causationEventId: workflowRuns.causationEventId,
        createdAt: workflowRuns.createdAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, organizationId),
          options.status ? eq(workflowRuns.status, options.status) : undefined,
          options.workflowName ? eq(workflowRuns.workflowName, options.workflowName) : undefined,
        ),
      )
      .orderBy(desc(workflowRuns.createdAt))
      .limit(limit);
  }

  /** Null for an unknown run, or one belonging to another organisation. */
  async describeRun(organizationId: string, runId: string): Promise<InspectedRun | null> {
    if (!organizationId || !runId) return null;

    const [run] = await this.listRunById(organizationId, runId);
    if (!run) return null;

    const steps = await this.db
      .select({
        stepName: workflowSteps.stepName,
        status: workflowSteps.status,
        output: workflowSteps.output,
        error: workflowSteps.error,
        attempt: workflowSteps.attempt,
        startedAt: workflowSteps.startedAt,
        completedAt: workflowSteps.completedAt,
      })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.organizationId, organizationId),
          eq(workflowSteps.workflowRunId, runId),
        ),
      )
      .orderBy(workflowSteps.startedAt);

    return { ...run, steps };
  }

  private async listRunById(
    organizationId: string,
    runId: string,
  ): Promise<Omit<InspectedRun, "steps">[]> {
    return this.db
      .select({
        workflowRunId: workflowRuns.workflowRunId,
        workflowName: workflowRuns.workflowName,
        status: workflowRuns.status,
        input: workflowRuns.input,
        output: workflowRuns.output,
        attempt: workflowRuns.attempt,
        maxAttempts: workflowRuns.maxAttempts,
        runAfter: workflowRuns.runAfter,
        lastError: workflowRuns.lastError,
        deadLetteredAt: workflowRuns.deadLetteredAt,
        correlationId: workflowRuns.correlationId,
        causationEventId: workflowRuns.causationEventId,
        createdAt: workflowRuns.createdAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, organizationId),
          eq(workflowRuns.workflowRunId, runId),
        ),
      )
      .limit(1);
  }
}
