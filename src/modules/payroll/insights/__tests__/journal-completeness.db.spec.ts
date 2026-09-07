/**
 * The half `insights-unit.spec.ts` cannot reach.
 *
 * `JournalService.buildJournal` read the run's line items with a bare
 * `.limit(1000)`. A payroll line item is written per employee per salary
 * component — the repo's own frozen calculation fixture produces 13 of them for
 * one employee — so the debit side of the journal stopped being the run at
 * roughly 77 employees. The credit side did not: "Salaries Payable" is summed
 * from `payroll_run_employees`, a different table with its own per-employee cap,
 * so for any run between 77 and 1000 employees the credits were complete while
 * the debits were short. The journal then could not balance, and
 * `journal-outbox.createBatch` wrote those figures into
 * `payroll_journal_batch_lines` — a table guarded by
 * `trg_guard_posted_payroll_journal_batch_line`, i.e. immutable — automatically,
 * on the same flow that marks the run PAID.
 *
 * The existing unit suite is literally named "JournalService — double-entry
 * balancing" and cannot see any of it: its `db` is a mock whose chain stub
 * ignores `.limit()`, so the boundary is unreachable from a fixture. Only a real
 * Postgres holding more than a thousand rows can answer whether the read covers
 * the run.
 *
 * Run via `pnpm test:db-specs`. The default hermetic jest config ignores this file.
 *   DATABASE_URL=... npx jest --config jest-db.json --runInBand \
 *     --testPathPattern="journal-completeness.db"
 *
 * Everything happens inside a transaction that is rolled back, fixtures
 * included, so the tests leave the database exactly as they found it.
 *
 * MONEY UNITS. Every fixture amount below is a rupee string with two decimals,
 * exactly as `payroll_line_items.amount` / `payroll_run_employees.net`
 * (`numeric(15,2)`) store it. The service converts to integer paise internally;
 * the assertions here are in rupees because `JournalResult.totalDebits` and
 * `.totalCredits` are the rupee wire format the report returns.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { JournalService } from "../journal.service";
import type { AccountingMappingsService } from "../accounting-mappings.service";
import type { Db } from "../../../../db/drizzle.types";

jest.setTimeout(180_000);

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("journal-completeness.db.spec.ts requires DATABASE_URL");
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

/**
 * One employee's payslip: thirteen components, the same shape the frozen
 * `replay-expected.json` fixture produces. Amounts are rupee strings.
 *
 * The set is deliberately balanced so the journal's own identity holds:
 *   debits  = EARNING + REIMBURSEMENT + EMPLOYER_CONTRIBUTION
 *   credits = DEDUCTION + TAX + ADJUSTMENT + EMPLOYER_CONTRIBUTION + net
 * which balances exactly when net = earnings + reimbursements − deductions −
 * tax − adjustments. That is what `NET_PER_EMPLOYEE` below is.
 */
const COMPONENTS: ReadonlyArray<{ code: string; name: string; category: string; amount: string }> = [
  { code: "BASIC", name: "Basic", category: "EARNING", amount: "50000.00" },
  { code: "HRA", name: "House Rent Allowance", category: "EARNING", amount: "20000.00" },
  { code: "SPECIAL", name: "Special Allowance", category: "EARNING", amount: "10000.00" },
  { code: "BONUS", name: "Bonus", category: "EARNING", amount: "5000.00" },
  { code: "TRAVEL", name: "Travel Reimbursement", category: "REIMBURSEMENT", amount: "2000.00" },
  { code: "EPF_ER", name: "EPF Employer", category: "EMPLOYER_CONTRIBUTION", amount: "1800.00" },
  { code: "GRATUITY", name: "Gratuity", category: "EMPLOYER_CONTRIBUTION", amount: "1200.00" },
  { code: "EPF_EMP", name: "EPF Employee", category: "DEDUCTION", amount: "1800.00" },
  { code: "PT", name: "Professional Tax", category: "DEDUCTION", amount: "200.00" },
  { code: "LWF", name: "Labour Welfare Fund", category: "DEDUCTION", amount: "20.00" },
  { code: "LOAN_EMI", name: "Loan EMI", category: "DEDUCTION", amount: "3000.00" },
  { code: "TDS", name: "TDS", category: "TAX", amount: "8000.00" },
  { code: "ROUNDING", name: "Rounding Adjustment", category: "ADJUSTMENT", amount: "0.30" },
];

/** Rupees. 87,000 earned + reimbursed − 13,020.30 withheld. */
const NET_PER_EMPLOYEE = "73979.70";

/** Rupees. EARNING + REIMBURSEMENT + EMPLOYER_CONTRIBUTION for one employee. */
const DEBIT_PER_EMPLOYEE = 90000;

const EMPLOYEES = 100;
const COST_CENTERS = ["CC-ALPHA", "CC-BETA"] as const;

/** 100 × 13 = 1,300 rows — comfortably past the 1,000-row read that truncated. */
const EXPECTED_LINE_ITEMS = EMPLOYEES * COMPONENTS.length;

/**
 * One journal line per (componentId, code, category, costCenter) group, plus a
 * second contra line for each EMPLOYER_CONTRIBUTION group, plus the single
 * "Salaries Payable" credit.
 */
const EMPLOYER_CONTRIBUTION_COMPONENTS = COMPONENTS.filter(
  (c) => c.category === "EMPLOYER_CONTRIBUTION",
).length;
const EXPECTED_JOURNAL_LINES =
  COMPONENTS.length * COST_CENTERS.length +
  EMPLOYER_CONTRIBUTION_COMPONENTS * COST_CENTERS.length +
  1;

const MAPPINGS = new Map<string, string>([
  ["EARNING", "Salaries Expense"],
  ["REIMBURSEMENT", "Reimbursements Expense"],
  ["EMPLOYER_CONTRIBUTION", "Employer Contribution Expense"],
  ["DEDUCTION", "Employee Deductions Payable"],
  ["TAX", "TDS Payable"],
  ["ADJUSTMENT", "Payroll Adjustments"],
  ["EMPLOYER_CONTRIBUTION_LIABILITY", "Statutory Liabilities Payable"],
]);

const mappingsService = {
  getMappings: async (): Promise<Map<string, string>> => MAPPINGS,
} as unknown as AccountingMappingsService;

describe("payroll journal completeness — real database", () => {
  let client: ReturnType<typeof postgres>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client) as unknown as Db;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /**
   * Plants a run of `EMPLOYEES` payees across `COST_CENTERS`, hands a
   * transaction-scoped JournalService to the body, and rolls everything back.
   */
  async function withPayrollRun<T>(
    body: (fixture: { journal: JournalService; orgId: string; month: string; runId: number }) => Promise<T>,
  ): Promise<T> {
    let captured: T | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '120s'"));

        const orgRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
        );
        const orgId = orgRows[0]?.id;
        if (!orgId) throw new Error("journal-completeness.db.spec.ts requires at least one seeded organization");

        // A month no live run can collide with; the read keys on (org, month, REGULAR).
        const month = "2999-07";
        const tag = randomUUID().slice(0, 8);

        await tx.execute(sql`DELETE FROM payroll_runs WHERE org_id = ${orgId} AND month = ${month}`);

        // Planted PREVIEW_READY: trg_guard_locked_payroll_line_item refuses line-item
        // writes on a locked run, so the run is flipped to LOCKED once it is populated.
        const runRows = await tx.execute<{ id: number }>(sql`
          INSERT INTO payroll_runs (org_id, month, status, run_type, net_total, employee_count)
          VALUES (${orgId}, ${month}, 'PREVIEW_READY', 'REGULAR',
                  ${(Number(NET_PER_EMPLOYEE) * EMPLOYEES).toFixed(2)}, ${EMPLOYEES})
          RETURNING id
        `);
        const runId = Number(runRows[0]?.id);
        if (!Number.isFinite(runId)) throw new Error("failed to insert payroll run fixture");

        const profileIds: number[] = [];
        for (const costCenter of COST_CENTERS) {
          const profileRows = await tx.execute<{ id: number }>(sql`
            INSERT INTO employee_salary_profiles
              (org_id, user_id, annual_ctc, effective_from, cost_center)
            VALUES (${orgId}, ${`jc-profile-${tag}-${costCenter}`}, ${"1200000.00"},
                    ${"2026-04-01"}, ${costCenter})
            RETURNING id
          `);
          const profileId = Number(profileRows[0]?.id);
          if (!Number.isFinite(profileId)) throw new Error("failed to insert salary profile fixture");
          profileIds.push(profileId);
        }

        /**
         * Two set-based statements, not 1,400 round trips.
         *
         * The row-at-a-time version below this comment used to insert each of the 100 run
         * employees and each of their 13 line items with its own `tx.execute`. That is 1,400
         * sequential round trips per test and 4,200 across the suite; against a Neon branch in
         * another region at roughly 450 ms each, all three tests hit the 180 s cap having
         * planted nothing. Nothing about the assertions was wrong — the fixture simply could
         * not finish, which is a property of where the database is rather than of the journal.
         *
         * `generate_series` for the employees and a CROSS JOIN against the component table for
         * their line items produce exactly the same rows: the profile assignment is still
         * `profileIds[i % n]`, expressed as an array subscript, and the count is still checked
         * against EXPECTED_LINE_ITEMS below rather than assumed.
         */
        const profileArray = sql.join(
          profileIds.map((id) => sql`${id}`),
          sql`, `,
        );
        await tx.execute(sql`
          INSERT INTO payroll_run_employees
            (org_id, run_id, user_id, profile_id, net, gross, status)
          SELECT ${orgId}, ${runId}, ${`jc-${tag}-`} || g,
                 (ARRAY[${profileArray}]::int[])[(g % ${profileIds.length}) + 1],
                 ${NET_PER_EMPLOYEE}::numeric, ${"87000.00"}::numeric, 'PENDING'
            FROM generate_series(0, ${EMPLOYEES - 1}) AS g
        `);

        const componentRows = sql.join(
          COMPONENTS.map(
            (component) => sql`(${component.code}, ${component.name},
                                ${component.category}::salary_component_type,
                                ${component.amount}::numeric)`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          INSERT INTO payroll_line_items
            (org_id, run_id, run_employee_id, code, name, category, amount, calc_method, calc_explain)
          SELECT ${orgId}, ${runId}, e.id, c.code, c.name, c.category, c.amount, 'FIXED', ${"{}"}::jsonb
            FROM payroll_run_employees e
            CROSS JOIN (VALUES ${componentRows}) AS c(code, name, category, amount)
           WHERE e.org_id = ${orgId} AND e.run_id = ${runId}
        `);

        const planted = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM payroll_line_items WHERE run_id = ${runId}`,
        );
        expect(Number(planted[0]?.n)).toBe(EXPECTED_LINE_ITEMS);

        await tx.execute(sql`UPDATE payroll_runs SET status = 'LOCKED' WHERE id = ${runId}`);

        const scoped = tx as unknown as Db;
        captured = await body({
          journal: new JournalService(scoped, mappingsService),
          orgId,
          month,
          runId,
        });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    if (captured === undefined) throw new Error("fixture did not run");
    return captured;
  }

  it("sums every line item of a 1,300-item run, so the journal balances", async () => {
    const result = await withPayrollRun(async ({ journal, orgId, month }) =>
      journal.buildJournal(orgId, month),
    );

    // Rupees. Debits are EARNING + REIMBURSEMENT + EMPLOYER_CONTRIBUTION over
    // the whole run; a truncated read makes this strictly smaller.
    expect(result.totalDebits).toBe(DEBIT_PER_EMPLOYEE * EMPLOYEES);
    expect(result.totalCredits).toBe(DEBIT_PER_EMPLOYEE * EMPLOYEES);
    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.unmappedCodes).toEqual([]);
    expect(result.provisional).toBe(false);
  });

  it("keeps the cost-centre grain, so one group holds exactly its half of the run", async () => {
    const result = await withPayrollRun(async ({ journal, orgId, month }) =>
      journal.buildJournal(orgId, month),
    );

    expect(result.lines).toHaveLength(EXPECTED_JOURNAL_LINES);

    // 50 of the 100 payees sit in CC-ALPHA; BASIC is ₹50,000 each.
    const basicAlpha = result.lines.filter(
      (l) => l.description === "Basic (BASIC)" && l.costCenter === "CC-ALPHA",
    );
    expect(basicAlpha).toHaveLength(1);
    expect(basicAlpha[0]?.debit).toBe(50000 * (EMPLOYEES / COST_CENTERS.length));

    const salariesPayable = result.lines.filter((l) => l.account === "Salaries Payable");
    expect(salariesPayable).toHaveLength(1);
    expect(salariesPayable[0]?.credit).toBe(Number(NET_PER_EMPLOYEE) * EMPLOYEES);
  });

  it("returns the same ordered line set twice, so the batch sourceHash is stable", async () => {
    const [first, second] = await withPayrollRun(async ({ journal, orgId, month }) => [
      await journal.buildJournal(orgId, month),
      await journal.buildJournal(orgId, month),
    ]);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.lines).toEqual(first?.lines);
  });
});
