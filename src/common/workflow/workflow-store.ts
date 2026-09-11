import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { workflowRuns, workflowSteps } from "../../db/schema";
import { correlationIdToPersist } from "../observability/async-hop";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import type { RunLifecycleStore } from "./workflow-runner";
import type { JsonValue, RecordedStep, WorkflowStepStore } from "./workflow.types";

export { drainBacklog, claimDueRuns } from "./workflow-claim";

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
