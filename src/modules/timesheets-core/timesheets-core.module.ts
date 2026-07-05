import { Module } from "@nestjs/common";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
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
import { AuditController } from "./audit.controller";

@Module({
  controllers: [
    EntriesController,
    TimerController,
    PeriodsController,
    ApprovalsController,
    BillingController,
    ReportsController,
    SettingsController,
    RatesController,
    AuditController,
  ],
  providers: [
    TimesheetsAuditService,
    RateResolverService,
    EntriesService,
    TimerService,
    PeriodsService,
    ApprovalsService,
    BillingService,
    ReportsService,
    SettingsService,
    RatesService,
  ],
  exports: [EntriesService, SettingsService],
})
export class TimesheetsCoreModule {}
