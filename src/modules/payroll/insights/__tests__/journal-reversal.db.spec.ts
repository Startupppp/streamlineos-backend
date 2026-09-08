/**
 * A reversal has to reverse the whole batch.
 *
 * `reverseBatch` read the original's lines with a bare `.limit(1000)` and then
 * inserted the contra batch directly at `status: "POSTED"` with
 * `totalDebits: batch.totalCredits` / `totalCredits: batch.totalDebits` — the
 * ORIGINAL header, swapped. Because it writes POSTED itself, `markPosted`'s
 * balance check never runs on it, so a batch with more than 1,000 lines was
 * "reversed" by its first 1,000 while the reversal's header claimed the full
 * amount. The ledger stayed short by the difference for good, and the only
 * evidence — a reversal whose `lineCount` is smaller than the original's — was
 * stored on both rows and read by nothing.
 *
 * The header is now derived from the contra lines the reversal actually
 * carries and refused unless it reproduces the original, and the read probes
 * one row past `PAYROLL_JOURNAL_BATCH_LINE_CAP` (the most lines
 * `buildJournal` can legally emit) instead of stopping at a thousand.
 *
 * This needs a real database: the defect is a row count crossing a `LIMIT`, and
 * a mocked `db` returns the array it was handed no matter what the limit says.
 *
 * Run via `pnpm test:db-specs`. The default hermetic jest config ignores this file.
 *   DATABASE_URL=... npx jest --config jest-db.json --runInBand \
 *     --testPathPattern="journal-reversal.db"
 *
 * MONEY UNITS. Line debit/credit are numeric(15,2) rupee strings, as the column
 * stores them. Every assertion below is in those same rupee strings.
 */
import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { JournalOutboxService } from "../journal-outbox.service";
import { PAYROLL_JOURNAL_BATCH_LINE_CAP } from "../../lib/query-bounds";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { JournalService } from "../journal.service";
// Only the relational-query table JournalOutboxService reaches through
// `db.query`; the schema barrel must not be namespace-imported (no-restricted-imports).
import { organizationMembers } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";

/** The relational-query surface `JournalOutboxService` reaches through `db.query`. */
const querySchema = { organizationMembers };

jest.setTimeout(300_000);

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect(): ReturnType<typeof postgres> {
  const raw = requireApprovedDatabaseUrl({
    spec: "journal-reversal.db.spec.ts",
    vars: ["DATABASE_URL"],
  });
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

/** Rupees on every debit line; the matching credit line carries the same. */
const PER_LINE = "125.00";

/**
 * Past the thousand-row read that truncated, comfortably inside the real
 * ceiling — so a correct reversal must carry all of them.
 */
const OVERSIZED_LINE_PAIRS = 620;

describe("journal batch reversal — real database", () => {
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
   * Plants a POSTED batch of `pairs` debit/credit line pairs whose header
   * totals match its lines, then hands the service to the body.
   */
  async function withPostedBatch<T>(
    pairs: number,
    body: (fixture: {
      outbox: JournalOutboxService;
      orgId: string;
      userId: string;
      batchId: number;
      lineCount: number;
      total: string;
    }) => Promise<T>,
    /** Header pairs, when the header should deliberately overstate the lines. */
    headerPairs: number = pairs,
  ): Promise<T> {
    let captured: T | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '240s'"));

        const orgRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
        );
        const orgId = orgRows[0]?.id;
        if (!orgId) throw new Error("journal-reversal.db.spec.ts requires at least one seeded organization");

        const userRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM users ORDER BY id LIMIT 1`,
        );
        const userId = userRows[0]?.id;
        if (!userId) throw new Error("journal-reversal.db.spec.ts requires at least one seeded user");

        const tag = randomUUID().slice(0, 8);
        const lineCount = pairs * 2;
        const total = (pairs * Number(PER_LINE)).toFixed(2);
        const headerTotal = (headerPairs * Number(PER_LINE)).toFixed(2);

        const batchRows = await tx.execute<{ id: number }>(sql`
          INSERT INTO payroll_journal_batches
            (org_id, period_key, version, status, provisional, source_hash,
             total_debits, total_credits, line_count, posted_at, posted_by, created_by)
          VALUES (${orgId}, ${"2999-09"}, 1, 'POSTED', false, ${`jr-${tag}`},
                  ${headerTotal}, ${headerTotal}, ${headerPairs * 2}, now(), ${userId}, ${userId})
          RETURNING id
        `);
        const batchId = Number(batchRows[0]?.id);
        if (!Number.isFinite(batchId)) throw new Error("failed to insert journal batch fixture");

        // trg_guard_posted_payroll_journal_batch_line fires on UPDATE/DELETE
        // only, so a posted batch can still be populated — which is exactly how
        // reverseBatch writes its own contra lines.
        for (let i = 0; i < pairs; i++) {
          await tx.execute(sql`
            INSERT INTO payroll_journal_batch_lines
              (org_id, batch_id, line_no, account, description, debit, credit, cost_center)
            VALUES
              (${orgId}, ${batchId}, ${i * 2 + 1}, 'Salaries Expense',
               ${`Component ${i}`}, ${PER_LINE}::numeric, 0, ${`CC-${i % 40}`}),
              (${orgId}, ${batchId}, ${i * 2 + 2}, 'Salaries Payable',
               ${`Component ${i} payable`}, 0, ${PER_LINE}::numeric, ${`CC-${i % 40}`})
          `);
        }

        const scoped = tx as unknown as Db;
        const outbox = new JournalOutboxService(
          scoped,
          {} as unknown as JournalService,
          { log: jest.fn() } as unknown as AuditService,
        );

        captured = await body({ outbox, orgId, userId, batchId, lineCount, total });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    if (captured === undefined) throw new Error("fixture did not run");
    return captured;
  }

  it("reverses every line of a batch larger than the thousand-row read", async () => {
    const reversal = await withPostedBatch(OVERSIZED_LINE_PAIRS, async ({ outbox, orgId, userId, batchId }) =>
      outbox.reverseBatch(orgId, userId, batchId, "mapping error"),
    );

    expect(reversal.lineCount).toBe(OVERSIZED_LINE_PAIRS * 2);
    expect(reversal.lines).toHaveLength(OVERSIZED_LINE_PAIRS * 2);
    expect(reversal.status).toBe("POSTED");
    expect(reversal.reversalOfBatchId).not.toBeNull();

    // Rupees. The reversal's own contra lines must add up to its header, which
    // is what markPosted would have checked had it been allowed to run.
    const expected = (OVERSIZED_LINE_PAIRS * Number(PER_LINE)).toFixed(2);
    expect(Number(reversal.totalDebits)).toBe(Number(expected));
    expect(Number(reversal.totalCredits)).toBe(Number(expected));

    const debitSum = reversal.lines.reduce((n, l) => n + Math.round(Number(l.debit) * 100), 0);
    const creditSum = reversal.lines.reduce((n, l) => n + Math.round(Number(l.credit) * 100), 0);
    expect(debitSum).toBe(Math.round(Number(reversal.totalDebits) * 100));
    expect(creditSum).toBe(Math.round(Number(reversal.totalCredits) * 100));
  });

  it("refuses a batch holding more lines than the journal builder can emit", async () => {
    // One line past the ceiling: the probe row the bound exists to see.
    const pairs = Math.ceil((PAYROLL_JOURNAL_BATCH_LINE_CAP + 1) / 2);

    await expect(
      withPostedBatch(pairs, async ({ outbox, orgId, userId, batchId }) =>
        outbox.reverseBatch(orgId, userId, batchId, "mapping error"),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to reverse a batch whose header overstates its own lines", async () => {
    // Four line pairs on disk under a header claiming ten — the exact shape a
    // truncated read used to produce, and the shape whose reversal used to be
    // written POSTED with the original's (larger) totals and no check at all.
    await expect(
      withPostedBatch(
        4,
        async ({ outbox, orgId, userId, batchId }) =>
          outbox.reverseBatch(orgId, userId, batchId, "mapping error"),
        10,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
