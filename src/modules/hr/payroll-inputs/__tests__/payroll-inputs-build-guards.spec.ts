import { PayrollInputsBuildService } from "../payroll-inputs-build.service";
import { buildReimbursementPayload } from "../payroll-inputs-money";
import type { hrPayrollInputPeriods } from "../../../../db/schema/payroll/input-capture";

/** Minimal thenable query chain: every builder method returns itself and awaits to `rows`. */
function chain(rows: unknown[]) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
    node[method] = () => node;
  }
  node.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(rows).then(onFulfilled);
  return node;
}

function makePeriod(): typeof hrPayrollInputPeriods.$inferSelect {
  return {
    id: 1,
    orgId: "org1",
    periodKey: "2026-07",
    status: "open",
    createdBy: "actor1",
    createdAt: new Date(),
    updatedAt: new Date(),
    builtAt: null,
    lockedAt: null,
    lockedBy: null,
    cutoffDate: null,
  };
}

/**
 * Only the member scan runs before the ceiling check, so a db whose `select`
 * returns that one chain is enough. The `as never` on the injected doubles is
 * the same idiom the sibling specs in this folder use for Nest constructor
 * injection, and `check:type-assertions` excludes the spec suite by design.
 */
function makeService(memberRows: unknown[]) {
  const db = { select: () => chain(memberRows) };
  return new PayrollInputsBuildService(db as never, {} as never, {} as never, {} as never);
}

function makeMembers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u${i}`,
    name: `User ${i}`,
    firstName: null,
    lastName: null,
    email: `u${i}@example.test`,
  }));
}

describe("PayrollInputsBuildService — scan ceiling", () => {
  it("refuses to write a partial period when the member scan overflows its ceiling", async () => {
    // 1001 rows: the service asks for CAP + 1 precisely so a full page is
    // distinguishable from a truncated one.
    await expect(
      makeService(makeMembers(1001)).buildSnapshots("org1", makePeriod()),
    ).rejects.toThrow(/exceeded the 1000-row ceiling on active organisation members/);
  });

  it("a scan that exactly fills the ceiling is not treated as truncated", async () => {
    // It proceeds past the ceiling check and fails later on the absent
    // collaborators, which is enough to prove the guard did not fire.
    await expect(
      makeService(makeMembers(1000)).buildSnapshots("org1", makePeriod()),
    ).rejects.not.toThrow(/row ceiling/);
  });

  it("returns without writing when the organisation has no active members", async () => {
    await expect(
      makeService([]).buildSnapshots("org1", makePeriod()),
    ).resolves.toBeUndefined();
  });
});

describe("buildReimbursementPayload — one unit across two source tables", () => {
  const claim = (amountCents: number) => ({
    id: 7,
    claimNumber: "CLM-1",
    amountCents,
    decidedAt: null,
  });
  const reimb = (amount: string) => ({
    id: 3,
    category: "TRAVEL",
    amount,
    description: null,
    payrollMonth: null,
    approvedAt: null,
  });

  it("converts a minor-unit claim into the rupee MoneyString the payslip expects", () => {
    // hr_insurance_claims.amount_cents = 30000 paise = Rs 300.00
    const payload = buildReimbursementPayload("u1", [], [claim(30_000)]);
    expect(payload.items[0]!.amount).toBe("300.00");
    expect(payload.totalAmount).toBe(300);
  });

  it("passes a rupee reimbursement through unchanged", () => {
    // reimbursements.amount = numeric(15,2) rupees
    const payload = buildReimbursementPayload("u1", [reimb("500.00")], []);
    expect(payload.items[0]!.amount).toBe("500.00");
    expect(payload.totalAmount).toBe(500);
  });

  it("sums both sources in one unit rather than adding rupees to paise", () => {
    const payload = buildReimbursementPayload("u1", [reimb("500.00")], [claim(30_000)]);
    // Rs 500 + Rs 300 = Rs 800. The pre-fix code produced 500 + 30000 = 30500.
    expect(payload.totalAmount).toBe(800);
    expect(payload.totalAmount).not.toBe(30_500);
  });

  it("does not accumulate float error across many rupee amounts", () => {
    const cents = Array.from({ length: 10 }, () => reimb("0.10"));
    // 10 x Rs 0.10 = Rs 1.00 exactly; a naive float sum gives 0.9999999999999999.
    expect(buildReimbursementPayload("u1", cents, []).totalAmount).toBe(1);
  });

  it("tags each item with the table it came from", () => {
    const payload = buildReimbursementPayload("u1", [reimb("500.00")], [claim(30_000)]);
    expect(payload.items.map((i) => i.source)).toEqual(["reimbursement", "benefits_claim"]);
  });
});

describe("buildReimbursementPayload — approved expense claims", () => {
  const expense = (currency: string) => ({
    id: 12,
    category: "Travel",
    amount: "1250.00",
    currency,
    description: "Cab",
    approvedAt: null,
    expenseDate: "2026-07-04",
  });

  it("adds an INR expense claim as a payable item dated by the claim", () => {
    const payload = buildReimbursementPayload("u1", [], [], [expense("INR")]);
    expect(payload.items).toEqual([
      expect.objectContaining({ id: 12, amount: "1250.00", source: "expense", date: "2026-07-04" }),
    ]);
    expect(payload.totalAmount).toBe(1250);
    expect(payload.excludedItems).toEqual([]);
  });

  it("keeps a non-INR expense claim out of the payable items and says why", () => {
    const payload = buildReimbursementPayload("u1", [], [], [expense("USD")]);
    expect(payload.items).toEqual([]);
    expect(payload.totalAmount).toBe(0);
    expect(payload.excludedItems).toEqual([
      expect.objectContaining({ id: 12, currency: "USD", reason: "Expense claim #12 is in USD; payroll only pays INR claims" }),
    ]);
  });
});
