import { Injectable, Inject, Logger } from "@nestjs/common";
import { FinancePostingService } from "../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant";
import { toPaise } from "./runs/lib/money";

@Injectable()
export class PayrollPostingService {
  private readonly logger = new Logger(PayrollPostingService.name);

  constructor(
    private readonly posting: FinancePostingService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

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
    const grossPaise = toPaise(gross ?? "0");
    const deductionsPaise = toPaise(deductions ?? "0");
    const netPaise = toPaise(net ?? "0");
    const employerCostPaise = toPaise(employerCost ?? "0");

    if (grossPaise <= 0 && netPaise <= 0) return;

    const totalExpense = ((grossPaise + employerCostPaise) / 100).toFixed(4);
    const netStr = (netPaise / 100).toFixed(4);
    const taxStr = (deductionsPaise / 100).toFixed(4);
    const employerStr = (employerCostPaise / 100).toFixed(4);

    if (employerCostPaise > 0) {
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
          { systemPurpose: "SALARY_EXPENSE", debit: (grossPaise / 100).toFixed(4), credit: "0" },
          { systemPurpose: "PAYROLL_PAYABLE", debit: "0", credit: netStr },
          { systemPurpose: "TAX_PAYABLE", debit: "0", credit: taxStr },
        ],
      });
    }
  }

  async postPaid(
    u: CurrentUserContext,
    runId: number,
    month: string,
    net: string,
  ): Promise<void> {
    const entryDate = `${month}-01`;
    const netPaise = toPaise(net ?? "0");
    if (netPaise <= 0) return;

    const netStr = (netPaise / 100).toFixed(4);

    await runInNewTenantTransaction(this.db, u.orgId, async () => {
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
    });
  }
}
