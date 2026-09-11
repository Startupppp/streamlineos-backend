import { Injectable, Inject } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { payrollRunEmployees, salaryLoans } from "../../../db/schema";
import { toCalculationSnapshot } from "../dto/payroll.schemas";

@Injectable()
export class LoanRecoveryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async postPayrollLock(orgId: string, runId: number, tx?: TenantTx): Promise<void> {
    if (tx) {
      await this.applyLoanRecovery(orgId, runId, tx);
      return;
    }
    await this.db.transaction((t) => this.applyLoanRecovery(orgId, runId, t));
  }

  private async applyLoanRecovery(orgId: string, runId: number, tx: TenantTx): Promise<void> {
    const empRows = await tx
      .select({ calculationSnapshot: payrollRunEmployees.calculationSnapshot })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)))
      .limit(1000);

    const loanIdSet = new Set<number>();
    for (const emp of empRows) {
      const snap = toCalculationSnapshot(emp.calculationSnapshot);
      for (const line of snap?.lines ?? []) {
        const match = /^LOAN_EMI_(\d+)$/.exec(line.code);
        if (match?.[1]) loanIdSet.add(parseInt(match[1], 10));
      }
    }

    if (loanIdSet.size === 0) return;

    const loans = await tx
      .select({ id: salaryLoans.id, paidEmis: salaryLoans.paidEmis, totalEmis: salaryLoans.totalEmis })
      .from(salaryLoans)
      .where(and(inArray(salaryLoans.id, [...loanIdSet]), eq(salaryLoans.orgId, orgId)))
      .limit(1000);

    const now = new Date();

    const repaidIds = loans
      .filter((l) => l.totalEmis != null && l.paidEmis + 1 >= l.totalEmis)
      .map((l) => l.id);
    const notRepaidIds = loans
      .filter((l) => l.totalEmis == null || l.paidEmis + 1 < l.totalEmis)
      .map((l) => l.id);

    if (notRepaidIds.length > 0)
      await tx
        .update(salaryLoans)
        .set({ paidEmis: sql`${salaryLoans.paidEmis} + 1` })
        .where(and(inArray(salaryLoans.id, notRepaidIds), eq(salaryLoans.orgId, orgId)));

    if (repaidIds.length > 0)
      await tx
        .update(salaryLoans)
        .set({ paidEmis: sql`${salaryLoans.paidEmis} + 1`, status: "REPAID", closedAt: now })
        .where(and(inArray(salaryLoans.id, repaidIds), eq(salaryLoans.orgId, orgId)));
  }
}
