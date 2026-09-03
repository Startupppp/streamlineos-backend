import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { workflowRuns, workflowSteps } from "../../db/schema";
import { correlationIdToPersist } from "../observability/async-hop";
import { forEachOrg } from "../tenant";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { leaseExpiry } from "./retry-policy";
import type { RunLifecycleStore, RunRecord } from "./workflow-runner";
import type { JsonValue, RecordedStep, WorkflowStepStore } from "./workflow.types";

/**
 * Database access for the runner — every statement inside a tenant transaction.
 *
 * This file used to say the opposite: that the runtime sat "deliberately outside
 * row-level security", because a worker claims across every organisation and a
 * tenant-scoped policy would make the claim return nothing. That was true when
 * `0208_workflow_runtime` created these tables. It stopped being true at
 * `0591_tenant_isolation_for_unprotected_tables`, which enabled RLS on
 * `workflow_runs` and `workflow_steps` with the standard
 * `organization_id = app.current_org_id()` policy — and nothing here changed to
 * match.
 *
 * The consequence was worse than "returns nothing". `app.current_org_id()`
 * RAISEs when no tenant GUC is set rather than returning NULL, so as the
 * application role every one of these statements threw
 * `no tenant context: app.organization_id is not set for this transaction`.
 * The whole durable runtime — claim, start, step and lifecycle writes — was
 * inoperative and `/cron/workflow-tick` answered 500. It survived CI because CI
 * connects as the database owner, which has BYPASSRLS and makes every policy
 * inert.
 *
 * So discovery moves inside a per-organisation loop, exactly as `forEachOrg`
 * documents for the sibling outbox publisher: `organizations` carries no tenant
 * column and therefore no policy, which is what makes enumerating tenants
 * possible without a bypass role. Per-run work resolves the organisation from
 * the run itself and opens — or joins — that organisation's transaction.
 */

const CLAIMABLE = sql`
  (status IN ('PENDING', 'SLEEPING') AND run_after <= now())
  OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
`;

/**
 * The runtime's stores are handed the organisation their run belongs to, and
 * every statement runs inside that organisation's transaction.
 *
 * `runInTenantTransaction` joins an ambient transaction when there is one and
 * opens a new one when there is not. Both matter here: a step's writes must
 * commit together with the memo that the step ran, so `withinStep`'s
 * transaction is joined rather than a second one opened beside it — while a
 * lifecycle write happens after that transaction has closed and needs one of
 * its own. It also refuses to open a transaction for one organisation inside
 * another's, which turns a cross-tenant write into an error at the seam instead
 * of a policy denial deep inside a query.
 */
export function createStepStore(db: Db, organizationId: string): WorkflowStepStore {
  return {
    async loadSteps(runId: string): Promise<RecordedStep[]> {
      const rows = await runInTenantTransaction(
        db,
        (tx) =>
          tx
            .select({
              stepName: workflowSteps.stepName,
              status: workflowSteps.status,
              output: workflowSteps.output,
            })
            .from(workflowSteps)
            .where(
              and(
                eq(workflowSteps.organizationId, organizationId),
                eq(workflowSteps.workflowRunId, runId),
              ),
            )
            .orderBy(asc(workflowSteps.startedAt)),
        { orgId: organizationId },
      );

      return rows.map((row) => ({
        stepName: row.stepName,
        status: row.status === "FAILED" ? "FAILED" : "COMPLETED",
        output: (row.output ?? null) as JsonValue | null,
      }));
    },

    async recordStep(step): Promise<void> {
      // Upsert: a retried step replaces its earlier failure rather than
      // colliding with the unique name, and a completed one is never rewritten.
      await runInTenantTransaction(
        db,
        async (tx) => {
          await tx
            .insert(workflowSteps)
            .values({
              workflowRunId: step.runId,
              organizationId: step.organizationId,
              stepName: step.stepName,
              status: step.status,
              output: step.output,
              error: step.error,
              attempt: step.attempt,
              completedAt: step.status === "COMPLETED" ? new Date() : null,
            })
            .onConflictDoUpdate({
              target: [
                workflowSteps.organizationId,
                workflowSteps.workflowRunId,
                workflowSteps.stepName,
              ],
              set: {
                status: step.status,
                output: step.output,
                error: step.error,
                attempt: step.attempt,
                completedAt: step.status === "COMPLETED" ? new Date() : null,
              },
            });
        },
        { orgId: step.organizationId },
      );
    },
  };
}

export function createLifecycleStore(db: Db, organizationId: string): RunLifecycleStore {
  /**
   * Scoped by run id *and* organisation.
   *
   * The policy would filter a foreign run anyway, but a silent zero-row update
   * is the wrong failure: naming the organisation keeps the predicate on the
   * `(organization_id, ...)` index and states the tenant the write belongs to
   * rather than leaving it to be inferred.
   */
  const ownRun = (runId: string) =>
    and(
      eq(workflowRuns.organizationId, organizationId),
      eq(workflowRuns.workflowRunId, runId),
    );

  const write = (set: Parameters<ReturnType<Db["update"]>["set"]>[0], runId: string) =>
    runInTenantTransaction(
      db,
      async (tx) => {
        await tx.update(workflowRuns).set(set).where(ownRun(runId));
      },
      { orgId: organizationId },
    );

  return {
    async complete(runId, output, at) {
      await write(
        {
          status: "COMPLETED",
          output: (output ?? null) as Record<string, unknown> | null,
          completedAt: at,
          leaseExpiresAt: null,
          lastError: null,
        },
        runId,
      );
    },

    async suspend(runId, wakeAt) {
      // Released, not held: a multi-day wait costs no worker and survives a deploy.
      await write({ status: "SLEEPING", runAfter: wakeAt, leaseExpiresAt: null }, runId);
    },

    async retry(runId, attempt, runAfter, error) {
      await write(
        { status: "PENDING", attempt, runAfter, leaseExpiresAt: null, lastError: error },
        runId,
      );
    },

    async deadLetter(runId, attempt, error, at) {
      await write(
        {
          status: "DEAD_LETTERED",
          attempt,
          lastError: error,
          deadLetteredAt: at,
          leaseExpiresAt: null,
        },
        runId,
      );
    },
  };
}

/**
 * Takes a lease on runs that are due.
 *
 * `SKIP LOCKED` is what lets several workers share the table without
 * coordinating: each takes rows the others are not already holding, instead of
 * queueing behind them. An expired lease is claimable again, which is how a run
 * abandoned by a killed process comes back.
 */
/**
 * How far behind the drain is, if anything is driving it.
 *
 * The runtime deliberately does not schedule itself — the module comment says so
 * — which means it is entirely dependent on something outside calling
 * `/cron/workflow-tick`. When nothing does, a durable workflow claims nothing,
 * runs nothing and reports nothing: a quote sits in its hold window forever, an
 * inbound message is never filed, and every surface says the job is in progress.
 *
 * That is the worst shape a failure can take, because it is indistinguishable
 * from work still happening. This turns it into a number somebody can alert on.
 * It observes and never claims, so calling it cannot itself advance a run and
 * mask the problem it exists to report.
 */
export interface DrainBacklog {
  /** Runs that are due right now and nobody has taken. */
  readonly due: number;
  /** How long the oldest of them has been waiting. Null when nothing is due. */
  readonly oldestDueSeconds: number | null;
}

/**
 * Summed per organisation rather than read across all of them at once, for the
 * same reason the claim is: the cross-tenant form is denied under RLS. The
 * backlog is the sum of every tenant's, and the oldest wait is the oldest of
 * them.
 */
export async function drainBacklog(db: Db): Promise<DrainBacklog> {
  let due = 0;
  let oldest = 0;

  await forEachOrg(
    db,
    "workflow-drain-backlog",
    async (tx, orgId) => {
      const rows = await tx.execute(sql`
        SELECT count(*)::int AS due,
               COALESCE(EXTRACT(EPOCH FROM (now() - min(run_after)))::int, 0) AS oldest
        FROM workflow_runs
        WHERE organization_id = ${orgId} AND (${CLAIMABLE})
      `);
      const row = ([...rows][0] ?? {}) as Record<string, unknown>;
      const orgDue = Number(row.due ?? 0);
      if (orgDue > 0) {
        due += orgDue;
        oldest = Math.max(oldest, Number(row.oldest ?? 0));
      }
    },
    "read",
  );

  return { due, oldestDueSeconds: due > 0 ? oldest : null };
}

export async function claimDueRuns(db: Db, limit: number): Promise<RunRecord[]> {
  const lease = leaseExpiry(new Date());
  const claimed: RunRecord[] = [];

  /**
   * Claimed one organisation at a time, because the cross-tenant form of this
   * statement is denied: `workflow_runs` carries
   * `organization_id = app.current_org_id()` and the function raises when no
   * tenant GUC is set. The batch limit is a budget spent across organisations
   * rather than per organisation, so one busy tenant cannot starve the tick and
   * the drain still claims at most `limit` runs per pass.
   */
  await forEachOrg(db, "workflow-claim-due-runs", async (tx, orgId) => {
    const remaining = limit - claimed.length;
    if (remaining <= 0) return;

    /**
     * The lease is bound through its column, never interpolated bare.
     *
     * A bare `Date` in a `sql` template hands postgres-js a value it cannot
     * serialise: the driver throws ERR_INVALID_ARG_TYPE at runtime while the
     * template typechecks perfectly. Every call to this function threw, so the
     * durable runtime claimed nothing, ran nothing and reported nothing — the
     * exact failure `drainBacklog` above was written to make visible, and the
     * reason an accepted inbound delivery was never filed.
     *
     * `sql.param` with the column applies that column's type mapper, which is how
     * `keysetAfter`/`keysetBefore` avoid the identical trap.
     */
    const rows = await tx.execute(sql`
      UPDATE workflow_runs SET
        status = 'RUNNING',
        lease_expires_at = ${sql.param(lease, workflowRuns.leaseExpiresAt)},
        updated_at = now()
      WHERE workflow_run_id IN (
        SELECT workflow_run_id FROM workflow_runs
        WHERE organization_id = ${orgId} AND (${CLAIMABLE})
        ORDER BY run_after ASC
        LIMIT ${remaining}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING workflow_run_id, organization_id, workflow_name, input, attempt, max_attempts, correlation_id
    `);

    for (const row of rows) {
      const record = row as Record<string, unknown>;
      claimed.push({
        workflowRunId: String(record.workflow_run_id),
        organizationId: String(record.organization_id),
        workflowName: String(record.workflow_name),
        input: (record.input ?? {}) as Record<string, unknown>,
        /**
         * Claimed back with the run, because the drain is the far side of an
         * asynchronous hop: the request that caused this run answered its client
         * minutes or days ago, and this column is the only thing left that points
         * at it. Left out of the projection, every step of every workflow reports
         * under whatever correlation id the cron tick happened to carry.
         */
        correlationId:
          typeof record.correlation_id === "string" ? record.correlation_id : null,
        attempt: Number(record.attempt ?? 0),
        maxAttempts: Number(record.max_attempts ?? 5),
      });
    }
  });

  return claimed;
}

export interface StartRunInput {
  readonly organizationId: string;
  readonly workflowName: string;
  readonly input: Record<string, unknown>;
  readonly correlationId?: string | null;
  readonly causationEventId?: string | null;
  readonly maxAttempts?: number;
}

/**
 * Creates a run, or returns the existing one for the same triggering event.
 *
 * A redelivered outbox event must resume the run it already started rather than
 * starting a second — which is the difference between an at-least-once event
 * stream and running a customer's onboarding twice.
 *
 * Both statements run in the run's own tenant transaction. The insert would
 * otherwise be denied outright, and — worse — the `onConflictDoNothing` fallback
 * read would come back empty under a policy that filtered it, which reads as
 * "no existing run" and starts a duplicate rather than resuming.
 */
export async function startRun(db: Db, input: StartRunInput): Promise<string | null> {
  return runInTenantTransaction(
    db,
    async (tx) => {
      const [row] = await tx
        .insert(workflowRuns)
        .values({
          organizationId: input.organizationId,
          workflowName: input.workflowName,
          input: input.input,
          correlationId: correlationIdToPersist(input.correlationId),
          causationEventId: input.causationEventId ?? null,
          ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        })
        .onConflictDoNothing()
        .returning({ workflowRunId: workflowRuns.workflowRunId });

      if (row) return row.workflowRunId;
      if (!input.causationEventId) return null;

      const [existing] = await tx
        .select({ workflowRunId: workflowRuns.workflowRunId })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.organizationId, input.organizationId),
            eq(workflowRuns.workflowName, input.workflowName),
            eq(workflowRuns.causationEventId, input.causationEventId),
          ),
        )
        .limit(1);

      return existing?.workflowRunId ?? null;
    },
    { orgId: input.organizationId },
  );
}
