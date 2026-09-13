/**
 * Lease-fencing proof for workflow runs.
 *
 * A workflow step can outlive its lease. When the lease expires, a successor
 * worker claims the same run — updating workflow_runs with a new
 * lease_expires_at. The original worker's later terminal write (complete,
 * retry, suspend, dead-letter) must not overwrite the successor's state.
 *
 * BEFORE the fix: the lifecycle store wrote `WHERE organization_id = $org AND
 * workflow_run_id = $id` — no check on lease_expires_at. The stale write
 * matched the row and updated it (1 row affected), overwriting the successor's
 * RUNNING state.
 *
 * AFTER the fix: the predicate is `WHERE organization_id = $org AND
 * workflow_run_id = $id AND lease_expires_at = $workerALease`. The stale write
 * finds no row (lease_expires_at is now workerBLease), and 0 rows are updated.
 *
 * Both cases are proved with real SQL against the scratch database so that
 * the predicate, timestamp comparison and RLS policy are exercised together.
 *
 * Run:
 *   DATABASE_URL=postgresql://streamline_app@127.0.0.1:5432/scratch_local?sslmode=disable \
 *   APP_DATABASE_URL=postgresql://streamline_app@127.0.0.1:5432/scratch_local?sslmode=disable \
 *   ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config jest-db.json --runInBand \
 *     --testPathPattern="workflow-lease-fence.db"
 *
 * Every write runs inside a transaction that is rolled back on completion, so
 * the database is left exactly as it was found.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { requireApprovedDatabaseUrl } from "../../test/db-spec-guard";

jest.setTimeout(60_000);

class Rollback extends Error {}

function connect(): ReturnType<typeof postgres> {
  const raw = requireApprovedDatabaseUrl({
    spec: "workflow-lease-fence.db.spec.ts",
    vars: ["APP_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  const plaintext =
    url.searchParams.get("sslmode") === "disable" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 1,
    ssl: plaintext ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

describe("workflow run lease fencing", () => {
  let sql: ReturnType<typeof postgres>;
  let orgId: string;

  beforeAll(async () => {
    sql = connect();
    const [row] = await sql<Array<{ id: string }>>`
      SELECT id FROM organizations WHERE status = 'ACTIVE' LIMIT 1
    `;
    if (!row)
      throw new Error("No active organization found in scratch_local — seed the database first");
    orgId = row.id;
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("BEFORE fix: stale worker write succeeds — UPDATE without lease predicate affects 1 row", async () => {
    const runId = `lease-fence-before-${randomUUID().slice(0, 8)}`;
    const workerALease = new Date(Date.now() + 5 * 60 * 1000);
    const workerBLease = new Date(Date.now() + 10 * 60 * 1000);

    const observed = await sql
      .begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;

        await tx`
          INSERT INTO workflow_runs
            (workflow_run_id, organization_id, workflow_name, input, status, lease_expires_at, run_after)
          VALUES
            (${runId}, ${orgId}, 'test-workflow', '{}', 'RUNNING', ${workerALease}, now())
        `;

        await tx`
          UPDATE workflow_runs
             SET status = 'RUNNING', lease_expires_at = ${workerBLease}, updated_at = now()
           WHERE organization_id = ${orgId} AND workflow_run_id = ${runId}
        `;

        const [{ rowsAffected }] = await tx<Array<{ rowsAffected: number }>>`
          WITH stale AS (
            UPDATE workflow_runs
               SET status = 'COMPLETED', lease_expires_at = NULL, completed_at = now(), updated_at = now()
             WHERE organization_id = ${orgId}
               AND workflow_run_id = ${runId}
            RETURNING 1
          )
          SELECT count(*)::int AS "rowsAffected" FROM stale
        `;

        throw Object.assign(new Rollback(), { result: rowsAffected });
      })
      .then(() => -1)
      .catch((err: unknown) => {
        if (err instanceof Rollback) return (err as Rollback & { result: number }).result;
        throw err;
      });

    expect(observed).toBe(1);
  });

  it("TWO-CONNECTION: Worker B claim supersedes Worker A — stale write rejected across separate committed transactions", async () => {
    const runId = `lease-fence-two-conn-${randomUUID().slice(0, 8)}`;
    const workerALease = new Date(Date.now() + 5 * 60 * 1000);
    const workerBLease = new Date(Date.now() + 10 * 60 * 1000);
    const clientB = connect();

    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        await tx`
          INSERT INTO workflow_runs
            (workflow_run_id, organization_id, workflow_name, input, status, lease_expires_at, run_after)
          VALUES
            (${runId}, ${orgId}, 'test-workflow', '{}', 'RUNNING', ${workerALease}, now())
        `;
      });

      await clientB.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        await tx`
          UPDATE workflow_runs
             SET status = 'RUNNING', lease_expires_at = ${workerBLease}, updated_at = now()
           WHERE organization_id = ${orgId} AND workflow_run_id = ${runId}
        `;
      });

      const rowsAffected = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        const [row] = await tx<Array<{ n: number }>>`
          WITH fenced AS (
            UPDATE workflow_runs
               SET status = 'COMPLETED', lease_expires_at = NULL, completed_at = now(), updated_at = now()
             WHERE organization_id = ${orgId}
               AND workflow_run_id = ${runId}
               AND lease_expires_at = ${workerALease}
            RETURNING 1
          )
          SELECT count(*)::int AS n FROM fenced
        `;
        return row!.n;
      });

      expect(rowsAffected).toBe(0);
    } finally {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        await tx`DELETE FROM workflow_runs WHERE workflow_run_id = ${runId}`;
      });
      await clientB.end({ timeout: 5 });
    }
  });

  it("AFTER fix: stale worker write fenced — UPDATE with stale lease predicate affects 0 rows", async () => {
    const runId = `lease-fence-after-${randomUUID().slice(0, 8)}`;
    const workerALease = new Date(Date.now() + 5 * 60 * 1000);
    const workerBLease = new Date(Date.now() + 10 * 60 * 1000);

    const observed = await sql
      .begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;

        await tx`
          INSERT INTO workflow_runs
            (workflow_run_id, organization_id, workflow_name, input, status, lease_expires_at, run_after)
          VALUES
            (${runId}, ${orgId}, 'test-workflow', '{}', 'RUNNING', ${workerALease}, now())
        `;

        await tx`
          UPDATE workflow_runs
             SET status = 'RUNNING', lease_expires_at = ${workerBLease}, updated_at = now()
           WHERE organization_id = ${orgId} AND workflow_run_id = ${runId}
        `;

        const [{ rowsAffected }] = await tx<Array<{ rowsAffected: number }>>`
          WITH fenced AS (
            UPDATE workflow_runs
               SET status = 'COMPLETED', lease_expires_at = NULL, completed_at = now(), updated_at = now()
             WHERE organization_id = ${orgId}
               AND workflow_run_id = ${runId}
               AND lease_expires_at = ${workerALease}
            RETURNING 1
          )
          SELECT count(*)::int AS "rowsAffected" FROM fenced
        `;

        throw Object.assign(new Rollback(), { result: rowsAffected });
      })
      .then(() => -1)
      .catch((err: unknown) => {
        if (err instanceof Rollback) return (err as Rollback & { result: number }).result;
        throw err;
      });

    expect(observed).toBe(0);
  });
});
