import { Inject, Injectable, Logger } from "@nestjs/common";
import { RecurringJournalsService } from "../accounting/gl/recurring-journals.service";
import { RecurringInvoicesService } from "../finance/ar/recurring-invoices.service";
import { RemindersService } from "../finance/ar/reminders.service";
import { InvoicesWriteService } from "../invoices/invoices-write.service";
import { RecurringBillsService } from "../finance/ap/recurring-bills.service";
import { BillsDueCheckService } from "../finance/ap/bills-due-check.service";
import { TaxComplianceService } from "../finance/tax/tax-compliance.service";
import { DepreciationRunsService } from "../finance/assets/depreciation-runs.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

interface RunResult {
  ran: string[];
  errors: Array<{ task: string; error: string }>;
}

@Injectable()
export class CronFinanceService {
  private readonly logger = new Logger(CronFinanceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
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
    const ranSet = new Set<string>();
    const errors: Array<{ task: string; error: string }> = [];

    await forEachOrg(
      this.db,
      "finance-recurring-flush",
      async (_tx, _orgId) => {
        try {
          await this.recurringJournals.runDueTemplates();
          ranSet.add("recurring-journals");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Recurring journals flush failed: ${msg}`);
          errors.push({ task: "recurring-journals", error: msg });
        }

        try {
          await this.recurringInvoices.runDueRecurringInvoices();
          ranSet.add("recurring-invoices");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Recurring invoices flush failed: ${msg}`);
          errors.push({ task: "recurring-invoices", error: msg });
        }

        try {
          await this.recurringBills.runDueRecurringBills();
          ranSet.add("recurring-bills");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Recurring bills flush failed: ${msg}`);
          errors.push({ task: "recurring-bills", error: msg });
        }
      },
    );

    return { ran: [...ranSet], errors };
  }

  async runDueChecks(): Promise<RunResult> {
    const ranSet = new Set<string>();
    const errors: Array<{ task: string; error: string }> = [];

    await forEachOrg(this.db, "finance-due-checks", async (_tx, orgId) => {
      try {
        await this.invoicesWrite.markOverdueInvoices(orgId);
        ranSet.add("mark-overdue-invoices");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Mark overdue invoices failed: ${msg}`);
        errors.push({ task: "mark-overdue-invoices", error: msg });
      }

      try {
        await this.reminders.processDueReminders(orgId);
        ranSet.add("invoice-reminders");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Invoice reminders failed: ${msg}`);
        errors.push({ task: "invoice-reminders", error: msg });
      }

      try {
        await this.billsDueCheck.checkBillsDue(orgId);
        ranSet.add("bills-due-check");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Bills due check failed: ${msg}`);
        errors.push({ task: "bills-due-check", error: msg });
      }

      try {
        await this.taxCompliance.checkTaxDue(orgId);
        ranSet.add("tax-compliance");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Tax compliance check failed: ${msg}`);
        errors.push({ task: "tax-compliance", error: msg });
      }
    });

    return { ran: [...ranSet], errors };
  }

  async runDepreciation(): Promise<RunResult> {
    const errors: Array<{ task: string; error: string }> = [];
    let totalPosted = 0;
    let totalFailed = 0;
    let anyRan = false;

    await forEachOrg(this.db, "finance-depreciation", async (_tx, _orgId) => {
      try {
        const results =
          await this.depreciationRuns.runDepreciationForDuePeriods();
        const errCount = results.filter((r) => r.error).length;
        totalPosted += results.length - errCount;
        totalFailed += errCount;
        anyRan = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Depreciation runs failed: ${msg}`);
        errors.push({ task: "depreciation-runs", error: msg });
      }
    });

    const ran = anyRan
      ? [`depreciation-runs (${totalPosted} posted, ${totalFailed} failed)`]
      : [];

    return { ran, errors };
  }
}
