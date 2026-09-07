/**
 * Real-database regression for per-row isolation in HrImportService.commitAll.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
 *     --testPathPattern="hr-import-row-savepoint.db"
 *
 * commitAll opens ONE transaction for the whole job and calls commitRow(tx, ...)
 * on it. When a row fails at the SQL level the transaction enters the aborted
 * state (SQLSTATE 25P02), and the catch handler's "mark this row errored" UPDATE
 * is itself rejected — so the handler throws, escapes commitAll, and the entire
 * job rolls back with a 500 and zero rows diagnosed.
 *
 * This can only be observed against a real Postgres: 25P02 is a server-side
 * transaction state, and a mocked db has no such state to enter. The two tests
 * below model the loop exactly — the first pins the broken shape's failure mode,
 * the second pins the savepoint shape the fix uses (Drizzle emits SAVEPOINT /
 * ROLLBACK TO SAVEPOINT for a nested tx.transaction(), via postgres.js
 * `client.savepoint`).
 */
import dotenv from "dotenv";
import postgres from "postgres";

function connect() {
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
    dotenv.config({ path: ".env" });
  }
  const raw = process.env.DATABASE_URL || process.env.APP_DATABASE_URL;
  if (!raw) throw new Error("hr-import-row-savepoint.db.spec.ts requires DATABASE_URL or APP_DATABASE_URL");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

const ABORTED_TRANSACTION = "25P02";

describe("hr import per-row commit isolation — real database", () => {
  let sql: ReturnType<typeof connect>;

  beforeAll(() => {
    sql = connect();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  /** Two import rows: the first commits cleanly, the second trips a constraint. */
  async function seedRows(tx: postgres.TransactionSql) {
    await tx`CREATE TEMP TABLE probe_import_rows (
      id serial PRIMARY KEY, status text NOT NULL, error text
    ) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE probe_target (
      id int PRIMARY KEY
    ) ON COMMIT DROP`;
    await tx`INSERT INTO probe_import_rows (status) VALUES ('valid'), ('valid')`;
    // Make row 2's insert collide, the way a real import row trips a constraint.
    await tx`INSERT INTO probe_target (id) VALUES (2)`;
  }

  it("without a savepoint, the catch handler's UPDATE is itself rejected with 25P02", async () => {
    let handlerError: unknown;

    await sql
      .begin(async (tx) => {
        await seedRows(tx);

        for (const rowId of [1, 2]) {
          try {
            await tx`INSERT INTO probe_target (id) VALUES (${rowId})`;
            await tx`UPDATE probe_import_rows SET status='committed' WHERE id=${rowId}`;
          } catch (err) {
            // This is what commitAll's catch does today — on the SAME tx.
            try {
              await tx`UPDATE probe_import_rows SET status='error', error='x' WHERE id=${rowId}`;
            } catch (recoveryErr) {
              handlerError = recoveryErr;
            }
          }
        }

        throw new Error("__rollback__");
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "__rollback__") return;
        throw err;
      });

    // The recovery UPDATE does not merely fail to help — it throws, and in the
    // real service nothing catches it, so the whole job rolls back.
    expect(handlerError).toBeDefined();
    expect((handlerError as { code?: string }).code).toBe(ABORTED_TRANSACTION);
  });

  it("with a per-row savepoint, the failing row is marked errored and the good row survives", async () => {
    let statuses: { id: number; status: string; error: string | null }[] = [];

    await sql
      .begin(async (tx) => {
        await seedRows(tx);

        for (const rowId of [1, 2]) {
          try {
            // Drizzle's nested tx.transaction() compiles to exactly this.
            await tx.savepoint(async (rowTx) => {
              await rowTx`INSERT INTO probe_target (id) VALUES (${rowId})`;
              await rowTx`UPDATE probe_import_rows SET status='committed' WHERE id=${rowId}`;
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Commit failed";
            // The outer transaction is healthy again after ROLLBACK TO SAVEPOINT.
            await tx`UPDATE probe_import_rows SET status='error', error=${message} WHERE id=${rowId}`;
          }
        }

        statuses = await tx<{ id: number; status: string; error: string | null }[]>`
          SELECT id, status, error FROM probe_import_rows ORDER BY id
        `;

        throw new Error("__rollback__");
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "__rollback__") return;
        throw err;
      });

    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ id: 1, status: "committed" });
    expect(statuses[1]!.status).toBe("error");
    expect(statuses[1]!.error).toContain("duplicate key");
  });
});
