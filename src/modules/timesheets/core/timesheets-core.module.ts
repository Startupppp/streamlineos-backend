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
import { TimesheetOverdueService } from "./overdue.service";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsBulkService } from "./approvals-bulk.service";
import { TimesheetApprovalsController } from "./approvals.controller";
import { BillingService } from "./billing.service";
import { TimesheetBillingController } from "./billing.controller";
import { ReportsService } from "./reports.service";
import { TimesheetAnalyticsService } from "./timesheet-analytics.service";
import { TimesheetReportsController } from "./reports.controller";
import { TimesheetCalendarController } from "./calendar.controller";
import { SettingsService } from "./settings.service";
import { TimesheetSettingsController } from "./settings.controller";
import { RatesService } from "./rates.service";
import { RatesController } from "./rates.controller";
import { BudgetsService } from "./budgets.service";
import { TimesheetBudgetsController } from "./budgets.controller";
import { TimesheetAuditController } from "./audit.controller";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
import { TimesheetExceptionsService } from "./exceptions.service";
import { TimesheetExceptionsController } from "./exceptions.controller";
import { ExceptionsDetectorService } from "./exceptions-detector.service";
import { TimesheetsAiController } from "./timesheets-ai.controller";
import { TimesheetsAiService } from "./timesheets-ai.service";
import { TimesheetsBillingAiService } from "./timesheets-billing-ai.service";
import { AiModule } from "../../ai/core/ai.module";
import { AccountingKernelModule } from "../../accounting/kernel/accounting-kernel.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { TimesheetLifecycleConsumer } from "./events/timesheet-lifecycle.consumer";
import { TimesheetRemindersSweepService } from "./reminders-sweep.service";
import { TIMESHEET_ATTENDANCE_PORT } from "./attendance/attendance.port";
import { SchemaAttendanceAdapter } from "./attendance/schema-attendance.adapter";
import { AttendanceDraftService } from "./attendance/attendance-draft.service";

@Module({
  imports: [AiModule, AccountingKernelModule, NotificationsModule, OutboxModule, WebhooksModule],
  controllers: [
    EntriesController,
    TimerController,
    TimesheetPeriodsController,
    TimesheetApprovalsController,
    TimesheetBillingController,
    TimesheetReportsController,
    TimesheetCalendarController,
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
    /** TS-11. The overdue/escalation queue, derived from grace days + reminderRules. */
    TimesheetOverdueService,
    ApprovalsService,
    ApprovalsBulkService,
    BillingService,
    ReportsService,
    TimesheetAnalyticsService,
    SettingsService,
    RatesService,
    BudgetsService,
    TeamService,
    TimesheetExceptionsService,
    ExceptionsDetectorService,
    TimesheetsAiService,
    TimesheetsBillingAiService,
    TimesheetRemindersSweepService,
    /**
     * TS-06. Registers itself for every timesheet lifecycle event type at boot.
     * Without it the publisher has no handler for the events TS-05 emits and
     * dead-letters all of them.
     */
    TimesheetLifecycleConsumer,
    /** TS-09. Reads the port above and writes draft entries; see the service. */
    AttendanceDraftService,
    /**
     * Attendance, through a port. Swapping this binding is how a deployment
     * says attendance is not a source of truth for timesheets, or moves to an
     * HR-published service when one exists — nothing else in the module changes.
     */
    { provide: TIMESHEET_ATTENDANCE_PORT, useClass: SchemaAttendanceAdapter },
  ],
  exports: [
    SettingsService,
    TimesheetsAuditService,
    ExceptionsDetectorService,
    EntriesPeriodService,
    TimesheetRemindersSweepService,
    TIMESHEET_ATTENDANCE_PORT,
  ],
})
export class TimesheetsCoreModule {}
