import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { loadRunPayableExpenses, payableExpenseClaims } from "../payable-expenses";

const dialect = new PgDialect();

function render(where: SQL | undefined) {
  if (!where) throw new Error("expected a predicate");
  return dialect.sqlToQuery(where);
}

describe("payableExpenseClaims — which expense claims payroll may pay", () => {
  it("takes only approved claims that are unpaid and not batched elsewhere, up to the period end", () => {
    const { sql, params } = render(payableExpenseClaims("org-1", ["u1"], "2026-07-31"));

    expect(sql).toContain('"expenses"."status" in');
    expect(params).toEqual(expect.arrayContaining(["APPROVED", "REIMBURSEMENT_PENDING", "2026-07-31", "org-1", "u1"]));
    expect(params).not.toContain("PENDING");
    expect(params).not.toContain("PAID");
    expect(sql).toContain('"expenses"."paid_at" is null');
    expect(sql).toContain('"expenses"."reimbursement_batch_id" is null');
  });
});

describe("loadRunPayableExpenses — the run's own guard", () => {
  function captureWhere() {
    let captured: SQL | undefined;
    const db = {
      select: () => ({
        from: () => ({
          where: (w: SQL) => {
            captured = w;
            return { limit: () => Promise.resolve([]) };
          },
        }),
      }),
    };
    return { db, where: () => captured };
  }

  it("pays only INR claims that no other payroll run has already allocated", async () => {
    const { db, where } = captureWhere();

    await loadRunPayableExpenses(db as never, "org-1", 42, ["u1"], "2026-02", 10);

    const { sql, params } = render(where());
    expect(params).toEqual(expect.arrayContaining(["INR", 42, "2026-02-28"]));
    expect(sql).toContain("not exists (select 1 from \"payroll_run_allocations\"");
    expect(sql).toContain("'EXPENSE'");
    expect(sql).toContain('"payroll_run_allocations"."run_id" <> $');
  });
});
