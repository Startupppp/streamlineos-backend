import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { reportError, runInRestoredContext } from "../observability";
import { runInNewTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { executeRun, type RunOutcome, type RunRecord } from "./workflow-runner";
import { WorkflowRegistry } from "./workflow-registry";
import {
  claimDueRuns,
  createLifecycleStore,
  createStepStore,
  startRun,
  type StartRunInput,
} from "./workflow-store";

export const WORKFLOW_BATCH_SIZE = 10;

export interface DrainResult {
  claimed: number;
  outcomes: Record<RunOutcome, number>;
}

@Injectable()
export class WorkflowRunnerService {
  private readonly logger = new Logger(WorkflowRunnerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
  ) {}

  /** Starts a run, or returns the one an earlier delivery of the same event started. */
  async start(input: StartRunInput): Promise<string | null> {
    return startRun(this.db, input);
  }

  /**
   * Claims and executes whatever is due.
   *
   * Sequential rather than concurrent: each run holds a database connection for
   * its steps, and a batch running in parallel would take the pool for the rest
   * of the request path. Throughput comes from running the drain often, and from
   * more workers, not from more concurrency inside one.
   */
  async drain(limit: number = WORKFLOW_BATCH_SIZE): Promise<DrainResult> {
    const runs = await claimDueRuns(this.db, limit);
    const outcomes: Record<RunOutcome, number> = {
      completed: 0,
      suspended: 0,
      retry: 0,
      "dead-lettered": 0,
    };

    for (const run of runs) {
      const outcome = await this.runOne(run);
      outcomes[outcome] += 1;
    }

    if (runs.length > 0)
      this.logger.log(
        `Drained ${String(runs.length)} run(s) — ` +
          Object.entries(outcomes)
            .filter(([, count]) => count > 0)
            .map(([name, count]) => `${name}: ${String(count)}`)
            .join(", "),
      );

    return { claimed: runs.length, outcomes };
  }

  /**
   * Every run is executed inside the context its producer persisted.
   *
   * The drain is the far side of an asynchronous hop. It runs on a cron tick, in
   * a process that never served the request the run came from, so there is no
   * scope to inherit — and inheriting the tick's would be worse than none, since
   * it would file the work under the sweep that happened to pick it up. Stated
   * from the row, `workflow_runs.correlation_id` joins every step's log line,
   * every error report and every span back to the request that caused the run.
   */
  private async runOne(run: RunRecord): Promise<RunOutcome> {
    return runInRestoredContext(
      {
        correlationId: run.correlationId,
        orgId: run.organizationId,
        route: `workflow:${run.workflowName}`,
        span: {
          name: "workflow.run",
          attributes: {
            "workflow.name": run.workflowName,
            "workflow.attempt": run.attempt + 1,
          },
        },
      },
      () => this.execute(run),
    );
  }

  private async execute(run: RunRecord): Promise<RunOutcome> {
    return executeRun({
      run,
      registry: this.registry,
      steps: createStepStore(this.db, run.organizationId),
      lifecycle: createLifecycleStore(this.db, run.organizationId),

      /**
       * Each step gets its own tenant transaction.
       *
       * Two reasons, and both are requirements rather than preferences. The
       * step's queries need the organisation GUC or row-level security denies
       * them — a worker has no ambient request context to borrow. And the step's
       * writes commit together with the record that it ran, so a crash between
       * the two cannot leave work done with no memo of it, which would repeat
       * the work on the next attempt.
       */
      withinStep: (stepName, fn) =>
        runInNewTenantTransaction(this.db, run.organizationId, async () => {
          this.logger.debug(`${run.workflowName}/${stepName} — org ${run.organizationId}`);
          return fn();
        }),

      onError: (error, failed) => {
        // A workflow failure that is only logged is the next outage nobody saw.
        reportError(error, {
          workflow: failed.workflowName,
          runId: failed.workflowRunId,
          orgId: failed.organizationId,
          attempt: failed.attempt + 1,
        });
      },
    });
  }
}
