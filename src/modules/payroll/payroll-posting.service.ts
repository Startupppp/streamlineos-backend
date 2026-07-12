import { Injectable, Logger } from "@nestjs/common";
import { FinancePostingService } from "../accounting/finance-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class PayrollPostingService {
  private readonly logger = new Logger(PayrollPostingService.name);

  constructor(private readonly posting: FinancePostingService) {}

  async postFinalized(
    u: CurrentUserContext,
    runId: number,
    month: string,
    gross: string,
    deductions: string,
    net: string,
    employerCost: string,
  ): Promise<void> {
    const entryDate = `${month}-01`;
    const grossNum = parseFloat(gross ?? "0");
    const deductionsNum = parseFloat(deductions ?? "0");
    const netNum = parseFloat(net ?? "0");
    const employerCostNum = parseFloat(employerCost ?? "0");

    if (grossNum <= 0 && netNum <= 0) return;

    const totalExpense = (grossNum + employerCostNum).toFixed(4);
    const netStr = netNum.toFixed(4);
    const taxStr = deductionsNum.toFixed(4);
    const employerStr = employerCostNum.toFixed(4);

    try {
      if (employerCostNum > 0) {
        await this.posting.postJournal(u, {
          entryDate,
          description: `Payroll accrual ${month} — salary expense`,
          sourceType: "PAYROLL_RUN",
          sourceId: String(runId),
          sourceEvent: "finalized",
          lines: [
            { systemPurpose: "SALARY_EXPENSE", debit: totalExpense, credit: "0" },
            { systemPurpose: "PAYROLL_PAYABLE", debit: "0", credit: netStr },
            { systemPurpose: "TAX_PAYABLE", debit: "0", credit: taxStr },
            { systemPurpose: "EXPENSE_CLEARING", debit: "0", credit: employerStr },
          ],
        });
      } else {
        await this.posting.postJournal(u, {
          entryDate,
          description: `Payroll accrual ${month} — salary expense`,
          sourceType: "PAYROLL_RUN",
          sourceId: String(runId),
          sourceEvent: "finalized",
          lines: [
            { systemPurpose: "SALARY_EXPENSE", debit: (grossNum).toFixed(4), credit: "0" },
            { systemPurpose: "PAYROLL_PAYABLE", debit: "0", credit: netStr },
            { systemPurpose: "TAX_PAYABLE", debit: "0", credit: taxStr },
          ],
        });
      }
    } catch (err) {
      this.logger.error("Payroll finalized ledger posting failed", { runId, month, err });
    }
  }

  async postPaid(
    u: CurrentUserContext,
    runId: number,
    month: string,
    net: string,
  ): Promise<void> {
    const entryDate = `${month}-01`;
    const netNum = parseFloat(net ?? "0");
    if (netNum <= 0) return;

    const netStr = netNum.toFixed(4);

    try {
      await this.posting.postJournal(u, {
        entryDate,
        description: `Payroll payment ${month} — bank disbursement`,
        sourceType: "PAYROLL_RUN",
        sourceId: String(runId),
        sourceEvent: "paid",
        lines: [
          { systemPurpose: "PAYROLL_PAYABLE", debit: netStr, credit: "0" },
          { systemPurpose: "BANK_CLEARING", debit: "0", credit: netStr },
        ],
      });
    } catch (err) {
      this.logger.error("Payroll paid ledger posting failed", { runId, month, err });
    }
  }
}
