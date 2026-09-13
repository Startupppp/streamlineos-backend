import { Injectable, Logger } from "@nestjs/common";
import { PostingCommandService } from "../accounting/adapters/posting-command.service";
import {
  AdapterRejection,
  type PayrollRunPosting,
} from "../accounting/adapters/posting-command.types";
import { BooksService } from "../accounting/kernel/books.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { toPaise } from "./runs/lib/money";

/**
 * Payroll's hand-off to accounting.
 *
 * Payroll owns the numbers; accounting only decides which account each total
 * lands in. Nothing here names a GL account — every line is a `GlSystemTag`
 * resolved against the org's own chart by the anti-corruption layer, so a
 * tenant renumbering their accounts cannot break payroll.
 *
 * Only summary totals cross this boundary. Payslips stay in payroll.
 */
@Injectable()
export class PayrollPostingService {
  private readonly logger = new Logger(PayrollPostingService.name);

  constructor(
    private readonly posting: PostingCommandService,
    private readonly books: BooksService,
  ) {}

  /**
   * The accrual, posted when a run is locked.
   *
   *   salary expense           gross + employer cost   (debit)
   *   net pay clearing         net                     (credit)
   *   statutory payable        employee deductions     (credit)
   *   statutory payable        employer contributions  (credit)
   */
  async postFinalized(
    u: CurrentUserContext,
    runId: number,
    month: string,
    gross: string,
    deductions: string,
    net: string,
    employerCost: string,
  ): Promise<void> {
    const grossPaise = toPaise(gross ?? "0");
    const deductionsPaise = toPaise(deductions ?? "0");
    const netPaise = toPaise(net ?? "0");
    const employerCostPaise = toPaise(employerCost ?? "0");

    if (grossPaise <= 0 && netPaise <= 0) return;

    const currency = await this.baseCurrency(u.orgId, runId);
    if (!currency) return;

    // Positive debits, negative credits — payroll never spells out sides.
    const lines: PayrollRunPosting["lines"] = [
      {
        tag: "salary",
        amountMinor: grossPaise + employerCostPaise,
        description: `Salary expense ${month}`,
      },
      {
        tag: "net_pay_clearing",
        amountMinor: -netPaise,
        description: `Net pay payable ${month}`,
      },
    ];

    if (deductionsPaise > 0) {
      lines.push({
        tag: "statutory_payable",
        amountMinor: -deductionsPaise,
        description: `Employee statutory deductions ${month}`,
      });
    }
    if (employerCostPaise > 0) {
      lines.push({
        tag: "statutory_payable",
        amountMinor: -employerCostPaise,
        description: `Employer statutory contributions ${month}`,
      });
    }

    await this.posting.submitPayrollRun(u.orgId, u.userId, {
      runId: String(runId),
      postingDate: `${month}-01`,
      currency,
      periodLabel: month,
      lines,
    });
  }

  /**
   * The disbursement, posted when the bank confirms the run is paid.
   *
   *   net pay clearing   net   (debit)
   *   bank               net   (credit)
   */
  async postPaid(u: CurrentUserContext, runId: number, month: string, net: string): Promise<void> {
    const netPaise = toPaise(net ?? "0");
    if (netPaise <= 0) return;

    const currency = await this.baseCurrency(u.orgId, runId);
    if (!currency) return;

    await this.posting.submit(u.orgId, u.userId, {
      sourceType: "payroll_run",
      sourceId: String(runId),
      purpose: "paid",
      journalDate: `${month}-01`,
      memo: `Payroll payment ${month} — bank disbursement`,
      lines: [
        {
          accountTag: "net_pay_clearing",
          debitMinor: netPaise,
          currency,
          description: `Net pay settled ${month}`,
        },
        {
          accountTag: "bank",
          creditMinor: netPaise,
          currency,
          description: `Bank disbursement ${month}`,
        },
      ],
    });
  }

  /**
   * Accounting is opt-in. An org that never enabled it has nowhere to post, and
   * that must not fail a payroll lock — so the absence of a book is a skip, not
   * an error, while every other rejection still surfaces.
   */
  private async baseCurrency(orgId: string, runId: number): Promise<string | null> {
    try {
      const book = await this.books.findDefault(orgId);
      if (!book) {
        this.logger.debug(
          `Accounting is not enabled for org ${orgId}; payroll run ${runId} was not posted to the ledger`,
        );
        return null;
      }
      return book.baseCurrency;
    } catch (err) {
      if (err instanceof AdapterRejection && err.code === "BOOK_NOT_ENABLED") return null;
      throw err;
    }
  }
}
