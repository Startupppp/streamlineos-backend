/**
 * Run completion measured against the run, not against the batch.
 *
 * `checkRunCompletion` decided a run was finished by comparing paid bank-batch
 * items to *batched* payees. But `batch-creator.service.ts:113-120` never
 * batches everyone: it drops payees an operator put on hold, payees with no
 * bank account, and payees owed nothing. So "every instruction settled" was
 * silently read as "every payee paid", and the intent it emitted carried
 * `payrollRuns.netTotal` — the whole run — into
 * `PayrollPostingService.postPaid`, which posts
 * `DR PAYROLL_PAYABLE / CR BANK_CLEARING` for that amount. A run with one held
 * payee therefore credited BANK_CLEARING for money the bank never moved and
 * wrote off a payable that is still owed.
 *
 * The two halves are independent and are tested separately:
 *
 *   1. A payee who is neither held nor owed nothing, and who never reached a
 *      batch, must stop the run completing at all.
 *   2. A deliberately held payee must not stop it — but the amount handed to
 *      accounting must be what was actually disbursed, so the held payee's
 *      payable stays open instead of being written off.
 *
 * The mocked sibling spec cannot see either: its `db` returns whatever
 * `subjects`/`paidSubjects` it was handed, so the predicate it is asked about
 * is the predicate it asserts. The eligibility rule here is real SQL over real
 * `payroll_run_employees` rows — `status <> 'HELD'`, `hold_reason IS NULL`,
 * `coalesce(net_payout_currency, net) > 0` — and only a database evaluates it.
 *
 * Run via `pnpm test:db-specs` (jest-db.json). Everything happens inside a
 * transaction that is rolled back.
 *
 * MONEY UNITS. Fixture amounts are rupee strings with two decimals, matching
 * `numeric(15,2)`. The posting intent's `net` is the same rupee wire format,
 * which is why the assertions compare against "900000.00" rather than paise.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { checkRunCompletion, type RunCompletionDeps } from "../payout-run-completion";
import { PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT } from "../../payroll-payout-posting-intent.consumer";
// Only the two relational-query tables checkRunCompletion reaches through
// `db.query`; the schema barrel must not be namespace-imported (no-restricted-imports).
import { organizationMembers, payrollBankBatches } from "../../../../../db/schema";
import type { Db } from "../../../../../db/drizzle.types";

/** The relational-query surface `checkRunCompletion` reaches through `db.query`. */
const querySchema = { organizationMembers, payrollBankBatches };

jest.setTimeout(180_000);

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("payout-run-completion.db.spec.ts requires DATABASE_URL");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const plaintext =
    process.env.PGSSLMODE === "disable" ||
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

const PAYEES = 10;
/** Rupees per payee. Ten of them make the run's ₹1,000,000 net total. */
const NET_PER_PAYEE = "100000.00";
const RUN_NET_TOTAL = "1000000.00";
/** Rupees actually disbursed when one of the ten is left out of the batch. */
const DISBURSED_NET = "900000.00";

type Outcome = {
  runStatus: string;
  intents: Array<{ net: string; runId: number; month: string }>;
  paidEmployeeCount: number;
};

/** How the one payee who is not paid comes to be missing from the batch. */
type Exclusion = "held" | "unbatched";

describe("payroll run completion — real database", () => {
  let client: ReturnType<typeof postgres>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client, { schema: querySchema }) as unknown as Db;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /**
   * Plants a LOCKED ten-payee run, batches and pays nine of them, leaves the
   * tenth out the way `exclusion` says, runs the completion check and reports
   * what the database ended up holding.
   */
  async function withCompletedBatch(exclusion: Exclusion): Promise<Outcome> {
    let captured: Outcome | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '120s'"));

        const orgRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
        );
        const orgId = orgRows[0]?.id;
        if (!orgId) throw new Error("payout-run-completion.db.spec.ts: seed DB needs at least one organization");

        // payroll_run_events.actor_id and payroll_bank_batch_items.user_id both
        // carry a real FK to users, so the fixture borrows an existing identity.
        const userRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM users ORDER BY id LIMIT 1`,
        );
        const actorId = userRows[0]?.id;
        if (!actorId) throw new Error("payout-run-completion.db.spec.ts: seed DB needs at least one user");

        const tag = randomUUID().slice(0, 8);
        const month = "2999-08";
        await tx.execute(sql`DELETE FROM payroll_runs WHERE org_id = ${orgId} AND month = ${month}`);

        const runRows = await tx.execute<{ id: number }>(sql`
          INSERT INTO payroll_runs (org_id, month, status, run_type, net_total, employee_count)
          VALUES (${orgId}, ${month}, 'LOCKED', 'REGULAR', ${RUN_NET_TOTAL}, ${PAYEES})
          RETURNING id
        `);
        const runId = Number(runRows[0]?.id);
        if (!Number.isFinite(runId)) throw new Error("failed to insert payroll run fixture");

        const runEmployeeIds: number[] = [];
        for (let i = 0; i < PAYEES; i++) {
          const held = i === 0 && exclusion === "held";
          const employeeRows = await tx.execute<{ id: number }>(sql`
            INSERT INTO payroll_run_employees
              (org_id, run_id, user_id, net, gross, status, hold_reason)
            VALUES (${orgId}, ${runId}, ${`prc-${tag}-${i}`}, ${NET_PER_PAYEE},
                    ${NET_PER_PAYEE}, ${held ? "HELD" : "PENDING"},
                    ${held ? "Under investigation" : null})
            RETURNING id
          `);
          const id = Number(employeeRows[0]?.id);
          if (!Number.isFinite(id)) throw new Error("failed to insert run employee fixture");
          runEmployeeIds.push(id);
        }

        // The batch mirrors what batch-creator would have produced: payee 0 is
        // excluded either way, the other nine are instructed and settle PAID.
        const batched = runEmployeeIds.slice(1);
        const batchRows = await tx.execute<{ id: number }>(sql`
          INSERT INTO payroll_bank_batches
            (org_id, run_id, batch_number, status, format, total_amount, item_count)
          VALUES (${orgId}, ${runId}, ${`PAY-299908-INR-${tag}`}, 'SENT', 'NEFT_CSV',
                  ${DISBURSED_NET}, ${batched.length})
          RETURNING id
        `);
        const batchId = Number(batchRows[0]?.id);
        if (!Number.isFinite(batchId)) throw new Error("failed to insert bank batch fixture");

        for (const runEmployeeId of batched) {
          await tx.execute(sql`
            INSERT INTO payroll_bank_batch_items
              (org_id, batch_id, run_employee_id, user_id, amount, account_masked, status, paid_at)
            VALUES (${orgId}, ${batchId}, ${runEmployeeId}, ${actorId}, ${NET_PER_PAYEE},
                    'XXXX4321', 'PAID', now())
          `);
        }

        const deps: RunCompletionDeps = {
          db: tx as unknown as Db,
          audit: { log: jest.fn() } as unknown as RunCompletionDeps["audit"],
          logger: {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
          } as unknown as RunCompletionDeps["logger"],
        };

        await checkRunCompletion(deps, orgId, batchId, actorId);

        const statusRows = await tx.execute<{ status: string }>(
          sql`SELECT status::text AS status FROM payroll_runs WHERE id = ${runId}`,
        );
        const intentRows = await tx.execute<{ payload: Record<string, unknown> }>(sql`
          SELECT payload FROM outbox_events
          WHERE organization_id = ${orgId}
            AND event_type = ${PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT}
            AND aggregate_id = ${String(runId)}
        `);
        const paidRows = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM payroll_run_employees
          WHERE run_id = ${runId} AND status = 'PAID'
        `);

        captured = {
          runStatus: String(statusRows[0]?.status),
          intents: intentRows.map((row) => ({
            net: String(row.payload.net),
            runId: Number(row.payload.runId),
            month: String(row.payload.month),
          })),
          paidEmployeeCount: Number(paidRows[0]?.n ?? 0),
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    if (!captured) throw new Error("fixture did not run");
    return captured;
  }

  it("refuses to complete a run while an unheld payee never reached a batch", async () => {
    const outcome = await withCompletedBatch("unbatched");

    expect(outcome.runStatus).toBe("LOCKED");
    expect(outcome.intents).toHaveLength(0);
    expect(outcome.paidEmployeeCount).toBe(0);
  });

  it("completes a run whose only unpaid payee is deliberately held", async () => {
    const outcome = await withCompletedBatch("held");

    expect(outcome.runStatus).toBe("PAID");
    expect(outcome.intents).toHaveLength(1);
    // Nine payees settled, not ten: the held payee's ₹100,000 stays in
    // PAYROLL_PAYABLE instead of being credited to BANK_CLEARING.
    expect(outcome.intents[0]?.net).toBe(DISBURSED_NET);
    expect(outcome.paidEmployeeCount).toBe(PAYEES - 1);
  });
});
