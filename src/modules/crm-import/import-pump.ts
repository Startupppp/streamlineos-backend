import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { runOutsidePoolBorrow } from "../../db/pool-telemetry";
import { reportError } from "../../common/observability";
import { runOutsideTenantContext } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { leaseExpiry, WorkflowRegistry } from "../../common/workflow";
import { executeRun, type RunOutcome, type RunRecord } from "../../common/workflow/workflow-runner";
import { createLifecycleStore, createStepStore } from "../../common/workflow/workflow-store";

/**
 * Advancing one import's run from the request that asked about it.
 *
 * The durable runtime is driven entirely by `GET|POST /cron/workflow-tick`, and
 * **nothing in this repository schedules that**: there is no in-process
 * scheduler, no `vercel.json`, nothing in `.github/` pointing at it. A durable
 * import in a deployment with no ticker would claim its run, do nothing, and
 * poll forever — which is a worse failure than the timeout it replaces, because
 * it looks like progress.
 *
 * So the request that commits an import also advances it, and the tick continues
 * it wherever one is configured. Nothing about the workflow changes: a pump is
 * simply another claimer of a due run, taking the same lease under the same
 * `SKIP LOCKED`, executing through the same `executeRun`, and recording through
 * the same stores. A run advanced by a pump and a run advanced by the tick are
 * the same run at the same memoised frontier.
 *
 * ── Targeted, not a drain ─────────────────────────────────────────────────
 *
 * `WorkflowRunnerService.drain()` claims whatever is due across every
 * organisation, ordered by age. Calling that from a tenant's import request
 * would make one tenant's upload execute another tenant's autonomy holds and
 * inbound ingress, and spend the request's latency budget on them. This claims
 * exactly the run the caller is waiting for, by identifier, and leaves the queue
 * alone.
 *
 * ── One attempt per call ──────────────────────────────────────────────────
 *
 * The workflow yields when its own wall-clock budget is spent, so an attempt is
 * bounded. Running attempts back to back until some larger budget expired would
 * make the request's duration a product of two budgets that nobody would think
 * to read together; one attempt makes the latency of a commit call exactly the
 * latency of a batch of batches. Finishing a large file is then several calls,
 * which is what the caller is polling for anyway.
 */
@Injectable()
export class ImportPump {
  private readonly logger = new Logger("CrmImport");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
  ) {}

  /**
   * Claims this run if it is due, executes one attempt, and reports what
   * happened. `null` means it was not claimable — already finished, dead, or
   * held by the cron worker at this moment — all of which are answers, not
   * errors: the caller re-reads the import's progress either way.
   */
  async advance(organizationId: string, workflowRunId: string): Promise<RunOutcome | null> {
    /**
     * Outside the request's own transaction, deliberately.
     *
     * `this.db` is a proxy onto the ambient tenant transaction, and the claim
     * has to be visible to other workers the instant it is taken — inside the
     * request it would stay invisible until the response committed, and a
     * rolled-back request would silently un-claim a run whose steps had already
     * written. Each step opens its own tenant transaction regardless, exactly as
     * it does under the cron worker.
     */
    return runOutsidePoolBorrow(() =>
      runOutsideTenantContext(async () => {
        const run = await this.claim(organizationId, workflowRunId);
        if (!run) return null;

        const outcome = await executeRun({
          run,
          registry: this.registry,
          steps: createStepStore(this.db),
          lifecycle: createLifecycleStore(this.db),
          withinStep: (stepName, fn) =>
            runInNewTenantTransaction(this.db, run.organizationId, () => {
              this.logger.debug(`${run.workflowName}/${stepName} — org ${run.organizationId}`);
              return fn();
            }),
          onError: (error, failed) =>
            reportError(error, {
              workflow: failed.workflowName,
              runId: failed.workflowRunId,
              orgId: failed.organizationId,
              attempt: failed.attempt + 1,
              phase: "import-pump",
            }),
        });

        this.logger.debug(`pumped ${workflowRunId} — ${outcome}`);
        return outcome;
      }),
    );
  }

  /**
   * The same claim `claimDueRuns` makes, narrowed to one run.
   *
   * `SKIP LOCKED` rather than a wait: if the cron worker is holding this run at
   * this instant, the right answer is "somebody else is on it", not a request
   * queued behind a five-minute lease. The organisation is in the predicate as
   * well as the identifier because `workflow_runs` is deliberately outside
   * row-level security — a worker claims across tenants — so this is the only
   * thing standing between a guessed identifier and another tenant's run.
   */
  private async claim(organizationId: string, workflowRunId: string): Promise<RunRecord | null> {
    const lease = leaseExpiry(new Date());

    const claimed = await this.db.execute(sql`
      UPDATE workflow_runs SET
        status = 'RUNNING',
        lease_expires_at = ${lease},
        updated_at = now()
      WHERE workflow_run_id = (
        SELECT workflow_run_id FROM workflow_runs
        WHERE workflow_run_id = ${workflowRunId}
          AND organization_id = ${organizationId}
          AND (
            (status IN ('PENDING', 'SLEEPING') AND run_after <= now())
            OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
          )
        FOR UPDATE SKIP LOCKED
      )
      RETURNING workflow_run_id, organization_id, workflow_name, input, attempt, max_attempts
    `);

    const [row] = [...claimed] as Record<string, unknown>[];
    if (!row) return null;

    return {
      workflowRunId: String(row.workflow_run_id),
      organizationId: String(row.organization_id),
      workflowName: String(row.workflow_name),
      input: (row.input ?? {}) as Record<string, unknown>,
      attempt: Number(row.attempt ?? 0),
      maxAttempts: Number(row.max_attempts ?? 5),
    };
  }
}
