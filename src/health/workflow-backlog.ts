import { sql } from "drizzle-orm";
import { forEachOrg } from "../common/tenant";
import type { Db } from "../db/drizzle.types";

const DUE = sql`(
  (status IN ('PENDING', 'SLEEPING') AND run_after <= now())
  OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
)`;

export interface WorkflowBacklog {
  readonly organizations: number;
  readonly failedOrganizations: number;
  readonly due: number;
  readonly oldestDueSeconds: number | null;
  readonly leased: number;
  readonly retrying: number;
  readonly deadLettered: number;
  readonly cancelled: number;
}

/**
 * Backlog, retry, dead-letter and cancellation counts for the durable runtime.
 *
 * Deliberately per-organisation. `workflow_runs` carries a tenant policy, and the
 * pooled connection has no tenant GUC set, so a single cross-tenant `count(*)`
 * run from a request handler matches zero rows and reports a permanently empty
 * backlog — a stall detector that can never fire. `forEachOrg` sets the GUC per
 * organisation, which is the only way this count is true.
 */
export async function aggregateWorkflowBacklog(db: Db): Promise<WorkflowBacklog> {
  let due = 0;
  let leased = 0;
  let retrying = 0;
  let deadLettered = 0;
  let cancelled = 0;
  let oldestDueSeconds: number | null = null;

  const outcome = await forEachOrg(
    db,
    "workflow-backlog",
    async (tx) => {
      const rows = await tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE ${DUE})::int AS due,
          COALESCE(EXTRACT(EPOCH FROM (now() - min(run_after) FILTER (WHERE ${DUE})))::int, 0) AS oldest,
          count(*) FILTER (WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at >= now())::int AS leased,
          count(*) FILTER (WHERE status IN ('PENDING', 'SLEEPING') AND attempt > 0)::int AS retrying,
          count(*) FILTER (WHERE status = 'DEAD_LETTERED')::int AS dead_lettered,
          count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
        FROM workflow_runs
      `);

      const row = ([...rows][0] ?? {}) as Record<string, unknown>;
      const orgDue = Number(row.due ?? 0);
      due += orgDue;
      leased += Number(row.leased ?? 0);
      retrying += Number(row.retrying ?? 0);
      deadLettered += Number(row.dead_lettered ?? 0);
      cancelled += Number(row.cancelled ?? 0);

      if (orgDue === 0) return;
      const oldest = Number(row.oldest ?? 0);
      if (oldestDueSeconds === null || oldest > oldestDueSeconds) oldestDueSeconds = oldest;
    },
    "read",
  );

  return {
    organizations: outcome.organizations,
    failedOrganizations: outcome.failed,
    due,
    oldestDueSeconds,
    leased,
    retrying,
    deadLettered,
    cancelled,
  };
}
