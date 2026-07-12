import { Injectable, Logger } from "@nestjs/common";
import { RecurringJournalsService } from "../accounting-gl/recurring-journals.service";
import { RecurringInvoicesService } from "../finance-ar/recurring-invoices.service";
import { RemindersService } from "../finance-ar/reminders.service";
import { InvoicesWriteService } from "../invoices/invoices-write.service";
import { RecurringBillsService } from "../finance-ap/recurring-bills.service";
import { BillsDueCheckService } from "../finance-ap/bills-due-check.service";
import { TaxComplianceService } from "../finance-tax/tax-compliance.service";
import { DepreciationRunsService } from "../finance-assets/depreciation-runs.service";

interface RunResult {
  ran: string[];
  errors: Array<{ task: string; error: string }>;
}

@Injectable()
export class CronFinanceService {
  private readonly logger = new Logger(CronFinanceService.name);

  constructor(
    private readonly recurringJournals: RecurringJournalsService,
    private readonly recurringInvoices: RecurringInvoicesService,
    private readonly reminders: RemindersService,
    private readonly invoicesWrite: InvoicesWriteService,
    private readonly recurringBills: RecurringBillsService,
    private readonly billsDueCheck: BillsDueCheckService,
    private readonly taxCompliance: TaxComplianceService,
    private readonly depreciationRuns: DepreciationRunsService,
  ) {}

  async runRecurringFlush(): Promise<RunResult> {
    const ran: string[] = [];
    const errors: Array<{ task: string; error: string }> = [];

    try {
      await this.recurringJournals.runDueTemplates();
      ran.push("recurring-journals");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Recurring journals flush failed: ${msg}`);
      errors.push({ task: "recurring-journals", error: msg });
    }

    try {
      await this.recurringInvoices.runDueRecurringInvoices();
      ran.push("recurring-invoices");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Recurring invoices flush failed: ${msg}`);
      errors.push({ task: "recurring-invoices", error: msg });
    }

    try {
      await this.recurringBills.runDueRecurringBills();
      ran.push("recurring-bills");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Recurring bills flush failed: ${msg}`);
      errors.push({ task: "recurring-bills", error: msg });
    }

    return { ran, errors };
  }

  async runDueChecks(): Promise<RunResult> {
    const ran: string[] = [];
    const errors: Array<{ task: string; error: string }> = [];

    try {
      await this.invoicesWrite.markOverdueInvoices();
      ran.push("mark-overdue-invoices");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Mark overdue invoices failed: ${msg}`);
      errors.push({ task: "mark-overdue-invoices", error: msg });
    }

    try {
      await this.reminders.processDueReminders();
      ran.push("invoice-reminders");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Invoice reminders failed: ${msg}`);
      errors.push({ task: "invoice-reminders", error: msg });
    }

    try {
      await this.billsDueCheck.checkBillsDue();
      ran.push("bills-due-check");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Bills due check failed: ${msg}`);
      errors.push({ task: "bills-due-check", error: msg });
    }

    try {
      await this.taxCompliance.checkTaxDue();
      ran.push("tax-compliance");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tax compliance check failed: ${msg}`);
      errors.push({ task: "tax-compliance", error: msg });
    }

    return { ran, errors };
  }

  async runDepreciation(): Promise<RunResult> {
    const ran: string[] = [];
    const errors: Array<{ task: string; error: string }> = [];

    try {
      const results = await this.depreciationRuns.runDepreciationForDuePeriods();
      const errCount = results.filter((r) => r.error).length;
      ran.push(`depreciation-runs (${results.length - errCount} posted, ${errCount} failed)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Depreciation runs failed: ${msg}`);
      errors.push({ task: "depreciation-runs", error: msg });
    }

    return { ran, errors };
  }
}
