import { Injectable, Inject } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { payrollRunEmployees, salaryLoans } from "../../../db/schema";

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
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const loanIdSet = new Set<number>();
    for (const emp of empRows) {
      const snap = emp.calculationSnapshot as { lines?: { code: string }[] } | null;
      for (const line of snap?.lines ?? []) {
        const match = /^LOAN_EMI_(\d+)$/.exec(line.code);
        if (match?.[1]) loanIdSet.add(parseInt(match[1], 10));
      }
    }

    if (loanIdSet.size === 0) return;

    const loans = await tx
      .select({ id: salaryLoans.id, paidEmis: salaryLoans.paidEmis, totalEmis: salaryLoans.totalEmis })
      .from(salaryLoans)
      .where(and(inArray(salaryLoans.id, [...loanIdSet]), eq(salaryLoans.orgId, orgId)));

    const now = new Date();
    for (const loan of loans) {
      const newPaidEmis = loan.paidEmis + 1;
      const isRepaid = loan.totalEmis != null && newPaidEmis >= loan.totalEmis;

      const loanUpdate: Partial<typeof salaryLoans.$inferInsert> = { paidEmis: newPaidEmis };
      if (isRepaid) {
        loanUpdate.status = "REPAID";
        loanUpdate.closedAt = now;
      }

      await tx.update(salaryLoans).set(loanUpdate).where(and(eq(salaryLoans.id, loan.id), eq(salaryLoans.orgId, orgId)));
    }
  }
}
