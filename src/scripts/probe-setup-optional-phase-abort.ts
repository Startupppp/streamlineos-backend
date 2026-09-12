/**
 * Live PostgreSQL reproduction of the OS-R4 hazard and of the savepoint that removes it.
 *
 * Claim under test: catching a rejected query does NOT recover an aborted PostgreSQL
 * transaction. The org-setup consumer runs inside the outbox relay's ambient tenant
 * transaction, catches optional-phase failures, and then writes `inbox_records` — so before
 * `runInConsumerSavepoint` that write died `25P02` and the event retried until dead-letter.
 *
 * Case A  failing statement caught with no savepoint  -> the follow-up write must raise 25P02
 * Case B  the same failure inside a SAVEPOINT         -> the follow-up write must succeed
 *
 * Writes nothing outside a TEMP table and rolls the whole transaction back either way.
 *
 * NOT run by this lane. Coordinator-run against a named disposable environment:
 *
 *   SETUP_MEASUREMENT_ENV=scratch_local \
 *   APP_DATABASE_URL=postgresql://streamline_app:...@127.0.0.1:5432/scratch_local \
 *     node -r ts-node/register/transpile-only src/scripts/probe-setup-optional-phase-abort.ts
 *
 * Pass criteria: exit 0, "case A: 25P02 as expected" and "case B: follow-up write survived".
 * A case A that does NOT raise 25P02 invalidates the premise and must be reported, not ignored.
 */
import postgres from "postgres";
import { assertDisposableTarget } from "./measure-org-setup-journey";

const ABORTED_SQLSTATE = "25P02";
const UNIQUE_VIOLATION_SQLSTATE = "23505";

function sqlStateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["APP_DATABASE_URL"];
  if (!databaseUrl) {
    console.error("APP_DATABASE_URL is required");
    process.exit(1);
  }
  const refusal = assertDisposableTarget(
    databaseUrl,
    process.env["SETUP_MEASUREMENT_ENV"],
    process.env["SETUP_ALLOW_REMOTE"] === "1",
  );
  if (!refusal.allowed) {
    console.error(`refusing to probe: ${refusal.reason}`);
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  const failures: string[] = [];
  try {
    console.log(`target: ${refusal.reason}`);

    await sql.begin(async (tx) => {
      await tx.unsafe(
        "CREATE TEMP TABLE setup_abort_probe (id int PRIMARY KEY) ON COMMIT DROP",
      );
      await tx.unsafe("INSERT INTO setup_abort_probe (id) VALUES (1)");

      let caughtA: string | null = null;
      try {
        await tx.unsafe("INSERT INTO setup_abort_probe (id) VALUES (1)");
      } catch (error: unknown) {
        caughtA = sqlStateOf(error);
      }
      if (caughtA !== UNIQUE_VIOLATION_SQLSTATE)
        failures.push(`case A setup: expected ${UNIQUE_VIOLATION_SQLSTATE}, saw ${caughtA ?? "no error"}`);

      let followUpA: string | null = null;
      try {
        await tx.unsafe("INSERT INTO setup_abort_probe (id) VALUES (2)");
        followUpA = "succeeded";
      } catch (error: unknown) {
        followUpA = sqlStateOf(error);
      }
      if (followUpA === ABORTED_SQLSTATE) console.log("case A: 25P02 as expected");
      else
        failures.push(
          `case A: the follow-up write ${followUpA === "succeeded" ? "SUCCEEDED" : `raised ${followUpA ?? "unknown"}`} ` +
            "— the aborted-transaction premise does not hold on this server",
        );
      // postgres-js records the rejected query on the scope and rethrows it at the end of
      // `begin`, so the transaction rolls back here whatever this callback caught.
    }).catch(() => undefined);

    await sql.begin(async (tx) => {
      await tx.unsafe(
        "CREATE TEMP TABLE setup_abort_probe_b (id int PRIMARY KEY) ON COMMIT DROP",
      );
      await tx.unsafe("INSERT INTO setup_abort_probe_b (id) VALUES (1)");

      let caughtB: string | null = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe("INSERT INTO setup_abort_probe_b (id) VALUES (1)");
        });
      } catch (error: unknown) {
        caughtB = sqlStateOf(error);
      }
      if (caughtB !== UNIQUE_VIOLATION_SQLSTATE)
        failures.push(`case B setup: expected ${UNIQUE_VIOLATION_SQLSTATE}, saw ${caughtB ?? "no error"}`);

      try {
        await tx.unsafe("INSERT INTO setup_abort_probe_b (id) VALUES (2)");
        console.log("case B: follow-up write survived");
      } catch (error: unknown) {
        failures.push(
          `case B: the follow-up write raised ${sqlStateOf(error) ?? "unknown"} — the savepoint did not recover the transaction`,
        );
      }

      throw new Error("probe rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "probe rollback") throw error;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("probe-setup-optional-phase-abort: both cases behaved as the repair assumes");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
