import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { workflowRuns } from "../../db/schema";
import { forEachOrg } from "../tenant";
import { leaseExpiry } from "./retry-policy";
import type { RunRecord } from "./workflow-runner";

const CLAIMABLE = sql`
  (status IN ('PENDING', 'SLEEPING') AND run_after <= now())
  OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
`;

interface DrainBacklog {
  /** Runs that are due right now and nobody has taken. */
  readonly due: number;
  /** How long the oldest of them has been waiting. Null when nothing is due. */
  readonly oldestDueSeconds: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      const row: Record<string, unknown> = [...rows][0] ?? {};
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

  await forEachOrg(db, "workflow-claim-due-runs", async (tx, orgId) => {
    const remaining = limit - claimed.length;
    if (remaining <= 0) return;

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
      RETURNING workflow_run_id, organization_id, workflow_name, input, attempt, max_attempts, correlation_id, lease_expires_at
    `);

    for (const row of rows) {
      const record: Record<string, unknown> = row;
      claimed.push({
        workflowRunId: String(record.workflow_run_id),
        organizationId: String(record.organization_id),
        workflowName: String(record.workflow_name),
        input: isRecord(record.input) ? record.input : {},
        correlationId:
          typeof record.correlation_id === "string" ? record.correlation_id : null,
        attempt: Number(record.attempt ?? 0),
        maxAttempts: Number(record.max_attempts ?? 5),
        leaseExpiresAt:
          record.lease_expires_at instanceof Date
            ? record.lease_expires_at
            : new Date(String(record.lease_expires_at)),
      });
    }
  });

  return claimed;
}
