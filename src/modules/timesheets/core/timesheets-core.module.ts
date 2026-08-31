import { Module } from "@nestjs/common";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { FxService } from "./fx.service";
import { EntriesService } from "./entries.service";
import { EntriesReadService } from "./entries-read.service";
import { EntriesPeriodService } from "./entries-period.service";
import { EntriesController } from "./entries.controller";
import { TimerService } from "./timer.service";
import { TimerController } from "./timer.controller";
import { PeriodsService } from "./periods.service";
import { PeriodsReadService } from "./periods-read.service";
import { PeriodsSubmitService } from "./periods-submit.service";
import { TimesheetPeriodsController } from "./periods.controller";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsBulkService } from "./approvals-bulk.service";
import { TimesheetApprovalsController } from "./approvals.controller";
import { BillingService } from "./billing.service";
import { TimesheetBillingController } from "./billing.controller";
import { ReportsService } from "./reports.service";
import { TimesheetAnalyticsService } from "./timesheet-analytics.service";
import { TimesheetReportsController } from "./reports.controller";
import { SettingsService } from "./settings.service";
import { TimesheetSettingsController } from "./settings.controller";
import { RatesService } from "./rates.service";
import { RatesController } from "./rates.controller";
import { BudgetsService } from "./budgets.service";
import { TimesheetBudgetsController } from "./budgets.controller";
import { TimesheetAuditController } from "./audit.controller";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
import { ExceptionsService } from "./exceptions.service";
import { TimesheetExceptionsController } from "./exceptions.controller";
import { ExceptionsDetectorService } from "./exceptions-detector.service";
import { TimesheetsAiController } from "./timesheets-ai.controller";
import { TimesheetsAiService } from "./timesheets-ai.service";
import { AiModule } from "../../ai/core/ai.module";

@Module({
  imports: [AiModule],
  controllers: [
    EntriesController,
    TimerController,
    TimesheetPeriodsController,
    TimesheetApprovalsController,
    TimesheetBillingController,
    TimesheetReportsController,
    TimesheetSettingsController,
    RatesController,
    TimesheetBudgetsController,
    TimesheetAuditController,
    TeamController,
    TimesheetExceptionsController,
    TimesheetsAiController,
  ],
  providers: [
    TimesheetsAuditService,
    RateResolverService,
    FxService,
    EntriesReadService,
    EntriesPeriodService,
    EntriesService,
    TimerService,
    PeriodsReadService,
    PeriodsSubmitService,
    PeriodsService,
    ApprovalsService,
    ApprovalsBulkService,
    BillingService,
    ReportsService,
    TimesheetAnalyticsService,
    SettingsService,
    RatesService,
    BudgetsService,
    TeamService,
    ExceptionsService,
    ExceptionsDetectorService,
    TimesheetsAiService,
  ],
  exports: [EntriesService, SettingsService, ExceptionsDetectorService, EntriesPeriodService],
})
export class TimesheetsCoreModule {}
