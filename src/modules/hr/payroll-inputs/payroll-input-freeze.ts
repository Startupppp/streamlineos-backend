import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { TenantTx } from "../../../db/drizzle.types";
import { hrLeaveLedger } from "../../../db/schema/hr/leave-ledger";
import { hrLoanRepayments } from "../../../db/schema/hr/benefits";
import { periodBoundsFrom } from "./payroll-period-key";

export async function freezePeriodSourceRecords(
  tx: TenantTx,
  orgId: string,
  periodKey: string,
): Promise<void> {
  const { start, end } = periodBoundsFrom(periodKey);

  await tx
    .update(hrLeaveLedger)
    .set({ payrollStatus: "locked" })
    .where(
      and(
        eq(hrLeaveLedger.orgId, orgId),
        eq(hrLeaveLedger.payrollStatus, "pending"),
        gte(hrLeaveLedger.effectiveDate, start),
        lte(hrLeaveLedger.effectiveDate, end),
      ),
    );

  const dueRepaymentIds = await tx
    .select({ id: hrLoanRepayments.id })
    .from(hrLoanRepayments)
    .where(
      and(
        eq(hrLoanRepayments.orgId, orgId),
        eq(hrLoanRepayments.status, "pending"),
        gte(hrLoanRepayments.dueDate, start),
        lte(hrLoanRepayments.dueDate, end),
      ),
    )
    .limit(1000);

  if (dueRepaymentIds.length > 0) {
    await tx
      .update(hrLoanRepayments)
      .set({ status: "deducted", payrollPeriodKey: periodKey, updatedAt: new Date() })
      .where(inArray(hrLoanRepayments.id, dueRepaymentIds.map((r) => r.id)));
  }
}

export async function releasePeriodSourceRecords(
  tx: TenantTx,
  orgId: string,
  periodKey: string,
): Promise<void> {
  const { start, end } = periodBoundsFrom(periodKey);

  await tx
    .update(hrLeaveLedger)
    .set({ payrollStatus: "pending" })
    .where(
      and(
        eq(hrLeaveLedger.orgId, orgId),
        eq(hrLeaveLedger.payrollStatus, "locked"),
        gte(hrLeaveLedger.effectiveDate, start),
        lte(hrLeaveLedger.effectiveDate, end),
      ),
    );
}
