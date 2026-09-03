/**
 * Real-database regression for the payroll-input reimbursement snapshot's units.
 *
 * Guarded by HR_DB_TESTS=1 so the default hermetic `jest` run is unaffected.
 * Run with:
 *   HR_DB_TESTS=1 DATABASE_URL=... npx jest --runInBand \
 *     --testPathPattern="payroll-inputs-reimbursement-units.db"
 *
 * Why this needs a real Postgres rather than a mocked db: the defect is a unit
 * mismatch between two columns, and the units are a property of the catalog and
 * of what the driver hands back — `reimbursements.amount` is numeric(15,2) and
 * arrives as the rupee string "500.00", while `hr_insurance_claims.amount_cents`
 * is integer and arrives as the number 30000. A mock would assert whatever it
 * was told, including the broken value. Here both rows are inserted into the
 * real tables, read back through the real driver, and pushed through the real
 * payroll consumer so the money consequence is measured, not assumed.
 *
 * The rows are created inside a transaction that is always rolled back, on an
 * organization that already exists (organizations.owner_membership_id is NOT
 * NULL behind a circular deferrable FK, so seeding a fresh org here is not
 * worth the blast radius).
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { buildReimbursementPayload } from "../payroll-inputs-money";
import { buildCalcPullsFromSections } from "../../../payroll/runs/lib/input-puller";
import { toPaise } from "../../../payroll/runs/lib/money";

const ENABLED = process.env.HR_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

function connect() {
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
    dotenv.config({ path: ".env" });
  }
  // DATABASE_URL (owner) first: hr_insurance_claims carries a tenant_isolation
  // RLS policy and this spec sets no app.current_org_id GUC.
  const raw = process.env.DATABASE_URL || process.env.APP_DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for HR_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

/** ₹500.00 reimbursement + ₹300.00 insurance claim = ₹800.00 owed. */
const REIMBURSEMENT_RUPEES = "500.00";
const CLAIM_MINOR_UNITS = 30_000;
const EXPECTED_TOTAL_RUPEES = 800;
const EXPECTED_PAYSLIP_PAISE = 80_000;

describeDb("payroll-input reimbursement snapshot — real database units", () => {
  let sql: ReturnType<typeof connect>;

  beforeAll(() => {
    sql = connect();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("the catalog says the two source columns carry different units", async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE (table_name = 'reimbursements'      AND column_name = 'amount')
          OR (table_name = 'hr_insurance_claims' AND column_name = 'amount_cents')
    `;
    const byTable = new Map(rows.map((r) => [r.table_name, r]));
    // Major units: a scaled decimal of rupees.
    expect(byTable.get("reimbursements")?.data_type).toBe("numeric");
    // Minor units: a plain integer count of paise.
    expect(byTable.get("hr_insurance_claims")?.data_type).toBe("integer");
  });

  it("sums a rupee reimbursement and a minor-unit claim into one correct rupee total", async () => {
    await sql
      .begin(async (tx) => {
        const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`;
        const [user] = await tx<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
        if (!org || !user) throw new Error("scratch database has no organization/user to borrow");

        const [reimb] = await tx<{ id: number; amount: string }[]>`
          INSERT INTO reimbursements (org_id, user_id, category, amount, status, created_at)
          VALUES (${org.id}, ${user.id}, 'TRAVEL', ${REIMBURSEMENT_RUPEES}, 'APPROVED', now())
          RETURNING id, amount
        `;

        const [plan] = await tx<{ id: number }[]>`
          INSERT INTO hr_benefit_plans (org_id, name, category, effective_from, status)
          VALUES (${org.id}, 'units-probe', 'health', CURRENT_DATE, 'active')
          RETURNING id
        `;

        const claimNumber = `units-${randomUUID().slice(0, 8)}`;
        const [claim] = await tx<
          { id: number; amount_cents: number; claim_number: string; decided_at: Date }[]
        >`
          INSERT INTO hr_insurance_claims
            (org_id, user_id, plan_id, claim_number, amount_cents, status, payout_route, decided_at)
          VALUES (${org.id}, ${user.id}, ${plan!.id}, ${claimNumber}, ${CLAIM_MINOR_UNITS},
                  'approved', 'payroll_payable', now())
          RETURNING id, amount_cents, claim_number, decided_at
        `;

        // What the driver actually hands the service: a rupee string and an integer.
        expect(typeof reimb!.amount).toBe("string");
        expect(Number(reimb!.amount)).toBe(500);
        expect(claim!.amount_cents).toBe(CLAIM_MINOR_UNITS);

        const payload = buildReimbursementPayload(
          user.id,
          [
            {
              id: reimb!.id,
              category: "TRAVEL",
              amount: reimb!.amount,
              description: null,
              payrollMonth: null,
              approvedAt: null,
            },
          ],
          [
            {
              id: claim!.id,
              claimNumber: claim!.claim_number,
              amountCents: claim!.amount_cents,
              decidedAt: claim!.decided_at,
            },
          ],
        );

        // The stored total is rupees, not rupees-plus-paise.
        expect(payload.totalAmount).toBe(EXPECTED_TOTAL_RUPEES);

        // Every items[] entry is a rupee MoneyString, whatever its source table.
        const claimItem = payload.items.find((i) => i.source === "benefits_claim");
        expect(claimItem?.amount).toBe("300.00");
        expect(payload.items.map((i) => i.amount)).toEqual(["500.00", "300.00"]);

        // The money consequence: what the payroll run would actually pay out.
        const pulls = buildCalcPullsFromSections(new Map([["reimbursement", payload]]));
        const paidPaise = (pulls?.approvedReimbursements ?? []).reduce(
          (sum, r) => sum + toPaise(r.amount),
          0,
        );
        expect(paidPaise).toBe(EXPECTED_PAYSLIP_PAISE);

        throw new Error("__rollback__");
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "__rollback__") return;
        throw err;
      });
  });
});
