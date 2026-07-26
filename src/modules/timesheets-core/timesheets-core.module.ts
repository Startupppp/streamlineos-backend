import { Module } from "@nestjs/common";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { FxService } from "./fx.service";
import { EntriesService } from "./entries.service";
import { EntriesController } from "./entries.controller";
import { TimerService } from "./timer.service";
import { TimerController } from "./timer.controller";
import { PeriodsService } from "./periods.service";
import { PeriodsController } from "./periods.controller";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsController } from "./approvals.controller";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import { ReportsService } from "./reports.service";
import { ReportsController } from "./reports.controller";
import { SettingsService } from "./settings.service";
import { SettingsController } from "./settings.controller";
import { RatesService } from "./rates.service";
import { RatesController } from "./rates.controller";
import { BudgetsService } from "./budgets.service";
import { BudgetsController } from "./budgets.controller";
import { AuditController } from "./audit.controller";
import { ExceptionsService } from "./exceptions.service";
import { ExceptionsController } from "./exceptions.controller";
import { ExceptionsDetectorService } from "./exceptions-detector.service";
import { TimesheetsAiController } from "./timesheets-ai.controller";
import { TimesheetsAiService } from "./timesheets-ai.service";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule],
  controllers: [
    EntriesController,
    TimerController,
    PeriodsController,
    ApprovalsController,
    BillingController,
    ReportsController,
    SettingsController,
    RatesController,
    BudgetsController,
    AuditController,
    ExceptionsController,
    TimesheetsAiController,
  ],
  providers: [
    TimesheetsAuditService,
    RateResolverService,
    FxService,
    EntriesService,
    TimerService,
    PeriodsService,
    ApprovalsService,
    BillingService,
    ReportsService,
    SettingsService,
    RatesService,
    BudgetsService,
    ExceptionsService,
    ExceptionsDetectorService,
    TimesheetsAiService,
  ],
  exports: [EntriesService, SettingsService, ExceptionsDetectorService],
})
export class TimesheetsCoreModule {}
