/**
 * A retried payout batch must replay, not 400.
 *
 * `createBatch` promises a `replayed: true` result when the same
 * Idempotency-Key arrives twice — that is the whole contract behind
 * `POST /payroll/runs/:id/payout/batches`. It could not keep it.
 *
 * The double-payment guard (migration 1049) reads every non-FAILED
 * `payroll_bank_batch_items` row on the run and drops those payees from
 * `eligible`. On a retry, the instructions the FIRST call wrote are exactly
 * those rows, so `eligible` is empty and the method threw
 * `BadRequestException("No eligible employees for payout batch")` before it
 * ever reached the idempotency lookup — which was keyed off `eligible` in the
 * first place. The replay path was structurally unreachable on precisely the
 * runs it exists for: the second call to a run that already has live
 * instructions.
 *
 * Over HTTP the `@Idempotent` interceptor masks this while its cached response
 * record lives; it bites the moment that record expires, and it bites every
 * in-process caller immediately.
 *
 * Only a database can show this. The guard is a real join across
 * `payroll_bank_batch_items` and `payroll_bank_batches`, and the replay lookup
 * is a real `inArray` over `payroll_bank_batches.idempotency_key` under the
 * partial unique indexes `uniq_payroll_bank_batch_items_batch_subject` and
 * `uniq_payroll_bank_batch_items_live_subject`. A mocked `db` returns whatever
 * rows it is handed and so asserts the premise instead of the behaviour.
 *
 * Bank-detail decryption is stubbed: envelope encryption is not what is under
 * test, and stubbing it keeps the fixture from needing a live key ring.
 *
 * Guarded by PAYROLL_DB_TESTS=1 so the default hermetic jest run is unaffected.
 *   PAYROLL_DB_TESTS=1 DATABASE_URL=... npx jest --runInBand \
 *     --testPathPattern="batch-creator-idempotent-replay.db"
 *
 * Everything happens inside a transaction that is rolled back.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { BadRequestException } from "@nestjs/common";
import { BatchCreatorService } from "../batch-creator.service";
import { payrollRuns, payrollBankBatches } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { StorageService } from "../../../storage/storage.service";
import type { EmploymentFactsService } from "../../../directory/employment-facts.service";
import type { BankDetails } from "../../../../common/hr/canonical-bank-details";

/** The relational-query surface `createBatch` reaches through `db.query`. */
const querySchema = { payrollRuns, payrollBankBatches };

const ENABLED = process.env.PAYROLL_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

if (ENABLED) jest.setTimeout(180_000);

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for PAYROLL_DB_TESTS");
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

const PAYEES = 3;
const NET_PER_PAYEE = "100000.00";

function bankDetailsFor(userId: string): BankDetails {
  return {
    accountNumber: `9900${userId.slice(-6).replace(/\D/g, "0").padStart(6, "0")}`,
    bankName: "Test Bank",
    branch: "Test Branch",
    ifsc: "TEST0000001",
    accountHolder: "Test Payee",
  };
}

/**
 * Stands in for `EmploymentFactsService`. Every payee gets bank details, so
 * eligibility turns purely on the double-payment guard — the thing under test.
 */
function stubEmploymentFacts(): EmploymentFactsService {
  return {
    getFactsBatch: async () => new Map(),
    getSensitiveFactsByPersonBatch: async () => new Map(),
    getSensitiveFactsBatch: async (_orgId: string, userIds: string[]) =>
      new Map(
        userIds.map((userId) => [
          userId,
          {
            bankDetails: bankDetailsFor(userId),
            taxId: null,
            panNumber: null,
            aadhaarNumber: null,
          },
        ]),
      ),
  } as unknown as EmploymentFactsService;
}

type Replay = {
  firstReplayed: boolean;
  secondReplayed: boolean;
  firstBatchIds: number[];
  secondBatchIds: number[];
  batchRowCount: number;
  itemRowCount: number;
  secondError: string | null;
};

describeDb("payout batch idempotent replay — real database", () => {
  let client: ReturnType<typeof postgres>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client, { schema: querySchema }) as unknown as Db;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  async function withRetriedBatch(): Promise<Replay> {
    let captured: Replay | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '120s'"));

        const orgRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
        );
        const orgId = orgRows[0]?.id;
        if (!orgId) throw new Error("PAYROLL_DB_TESTS needs at least one organization");

        // payroll_bank_batch_items.user_id and payroll_run_events.actor_id both
        // carry a real FK to users, so the fixture borrows real identities.
        const userRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM users ORDER BY id LIMIT ${PAYEES}`,
        );
        const payeeIds = userRows.map((row) => String(row.id));
        if (payeeIds.length < PAYEES)
          throw new Error(`PAYROLL_DB_TESTS needs at least ${PAYEES} users`);
        const actorId = payeeIds[0];
        if (!actorId) throw new Error("no actor");

        const tag = randomUUID().slice(0, 8);
        const month = "2999-09";
        await tx.execute(
          sql`DELETE FROM payroll_runs WHERE org_id = ${orgId} AND month = ${month}`,
        );

        const runRows = await tx.execute<{ id: number }>(sql`
          INSERT INTO payroll_runs (org_id, month, status, run_type, net_total, employee_count)
          VALUES (${orgId}, ${month}, 'LOCKED', 'REGULAR', ${String(PAYEES * 100000)}, ${PAYEES})
          RETURNING id
        `);
        const runId = Number(runRows[0]?.id);
        if (!Number.isFinite(runId)) throw new Error("failed to insert payroll run fixture");

        for (const userId of payeeIds) {
          await tx.execute(sql`
            INSERT INTO payroll_run_employees
              (org_id, run_id, user_id, net, gross, currency, status)
            VALUES (${orgId}, ${runId}, ${userId}, ${NET_PER_PAYEE}, ${NET_PER_PAYEE}, 'INR', 'PENDING')
          `);
        }

        const svc = new BatchCreatorService(
          tx as unknown as Db,
          { log: jest.fn() } as unknown as AuditService,
          { isConfigured: () => false } as unknown as StorageService,
          stubEmploymentFacts(),
        );

        const idemKey = `replay-${tag}`;
        const first = await svc.createBatch(orgId, runId, actorId, idemKey, undefined);

        let secondError: string | null = null;
        let secondReplayed = false;
        let secondBatchIds: number[] = [];
        try {
          const second = await svc.createBatch(orgId, runId, actorId, idemKey, undefined);
          secondReplayed = second.replayed;
          secondBatchIds = second.batches.map((b) => b.batch.id);
        } catch (error) {
          secondError =
            error instanceof BadRequestException
              ? `BadRequestException: ${error.message}`
              : String(error);
        }

        const batchCountRows = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM payroll_bank_batches
          WHERE org_id = ${orgId} AND run_id = ${runId}
        `);
        const itemCountRows = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM payroll_bank_batch_items i
          JOIN payroll_bank_batches b ON b.id = i.batch_id
          WHERE b.org_id = ${orgId} AND b.run_id = ${runId}
        `);

        captured = {
          firstReplayed: first.replayed,
          secondReplayed,
          firstBatchIds: first.batches.map((b) => b.batch.id),
          secondBatchIds,
          batchRowCount: Number(batchCountRows[0]?.n ?? -1),
          itemRowCount: Number(itemCountRows[0]?.n ?? -1),
          secondError,
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    if (!captured) throw new Error("fixture did not run");
    return captured;
  }

  it("returns the original batch on a retry instead of rejecting it", async () => {
    const outcome = await withRetriedBatch();

    expect(outcome.secondError).toBeNull();
    expect(outcome.firstReplayed).toBe(false);
    expect(outcome.secondReplayed).toBe(true);
    expect(outcome.secondBatchIds).toEqual(outcome.firstBatchIds);
  });

  it("writes no second set of payment instructions on the retry", async () => {
    const outcome = await withRetriedBatch();

    expect(outcome.batchRowCount).toBe(1);
    expect(outcome.itemRowCount).toBe(PAYEES);
  });

  it("still refuses a fresh key once every payee is already instructed", async () => {
    let captured: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '120s'"));
        const orgRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
        );
        const orgId = orgRows[0]?.id;
        if (!orgId) throw new Error("PAYROLL_DB_TESTS needs at least one organization");
        const userRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM users ORDER BY id LIMIT ${PAYEES}`,
        );
        const payeeIds = userRows.map((row) => String(row.id));
        const actorId = payeeIds[0];
        if (!actorId) throw new Error("no actor");

        const month = "2999-10";
        await tx.execute(
          sql`DELETE FROM payroll_runs WHERE org_id = ${orgId} AND month = ${month}`,
        );
        const runRows = await tx.execute<{ id: number }>(sql`
          INSERT INTO payroll_runs (org_id, month, status, run_type, net_total, employee_count)
          VALUES (${orgId}, ${month}, 'LOCKED', 'REGULAR', ${String(PAYEES * 100000)}, ${PAYEES})
          RETURNING id
        `);
        const runId = Number(runRows[0]?.id);
        for (const userId of payeeIds) {
          await tx.execute(sql`
            INSERT INTO payroll_run_employees
              (org_id, run_id, user_id, net, gross, currency, status)
            VALUES (${orgId}, ${runId}, ${userId}, ${NET_PER_PAYEE}, ${NET_PER_PAYEE}, 'INR', 'PENDING')
          `);
        }

        const svc = new BatchCreatorService(
          tx as unknown as Db,
          { log: jest.fn() } as unknown as AuditService,
          { isConfigured: () => false } as unknown as StorageService,
          stubEmploymentFacts(),
        );

        const tag = randomUUID().slice(0, 8);
        await svc.createBatch(orgId, runId, actorId, `first-${tag}`, undefined);
        try {
          // A DIFFERENT key is a new command, not a retry. The 1049
          // double-payment guard must still stop it.
          await svc.createBatch(orgId, runId, actorId, `second-${tag}`, undefined);
        } catch (error) {
          captured = error instanceof BadRequestException ? error.message : String(error);
        }
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(captured).toMatch(/already has a live payout instruction/i);
  });
});
