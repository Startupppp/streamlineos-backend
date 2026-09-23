/*
  The four finance modules, `CronFinanceController` and `CronFinanceService` are
  absent deliberately.

  They belonged to `modules/finance`, which the accounting rewrite replaced with
  the `gl_*` kernel; the scheduled work they registered — recurring journal /
  invoice / bill flushes, AR/AP/tax due checks, asset depreciation — has no
  counterpart there yet. Everything else main schedules is registered exactly as
  before.
*/

import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { AiModule } from "../ai/core/ai.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { AutomationModule } from "../automation/automation.module";
import { ChatModule } from "../chat/chat.module";
import { EmailModule } from "../email/email.module";
import { KbModule } from "../kb/kb.module";
import { SupportModule } from "../support/core/support.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OwnershipModule } from "../ownership/ownership.module";
import { HrAutomationsModule } from "../hr/automations/hr-automations.module";
import { HrTimeModule } from "../hr/time/hr-time.module";
import { HrHelpdeskModule } from "../hr/helpdesk/hr-helpdesk.module";
import { HrWorkflowsModule } from "../hr/workflows/hr-workflows.module";
import { HrCoreModule } from "../hr/core/hr-core.module";
import { HrLifecycleModule } from "../hr/lifecycle/hr-lifecycle.module";
import { HrGlobalModule } from "../hr/global/hr-global.module";
import { FeedbucketModule } from "../feedbucket/feedbucket.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { AiJobsModule } from "../ai/jobs/ai-jobs.module";
import { SupportKbGapModule } from "../support/kb-gap";
import { TimesheetsCoreModule } from "../timesheets/core/timesheets-core.module";
import { ESignModule } from "../e-sign/e-sign.module";
import { OrganizationModule } from "../organization/core/organization.module";
import { HrGovernanceModule } from "../hr/governance/hr-governance.module";
import { CronBillingController } from "./cron-billing.controller";
import { CronInvitationExpiryController } from "./cron-invitation-expiry.controller";
import { CronHrController } from "./cron-hr.controller";
import { CronHrNotificationsController } from "./cron-hr-notifications.controller";
import { CronPlatformController } from "./cron-platform.controller";
import { CronCalendarController } from "./cron-calendar.controller";
import { CronGdprController } from "./cron-gdpr.controller";
import { CronNotificationsController } from "./cron-notifications.controller";
import { CronNotificationRetentionController } from "./cron-notification-retention.controller";
import { CronOutboxController } from "./cron-outbox.controller";
import { CronSignController } from "./cron-sign.controller";
import { CronSupportController } from "./cron-support.controller";
import { ReportingModule } from "../reporting/reporting.module";
import { DealsModule } from "../deals/deals.module";
import { CronCrmForecastService } from "./cron-crm-forecast.service";
import { CronKbController } from "./cron-kb.controller";
import { CronBuildController } from "./cron-build.controller";
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { CronNotificationRetentionService } from "./cron-notification-retention.service";
import { NotificationRetentionService } from "../notifications/notification-retention.service";
import { PartitionMaintenanceService } from "../notifications/partition-maintenance.service";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronBillingService } from "./cron-billing.service";
import { CronInvitationExpiryService } from "./cron-invitation-expiry.service";
import { CronWorkflowService } from "./cron-workflow.service";
import { CronHolidayService } from "./cron-holiday.service";
import { CronHrService } from "./cron-hr.service";
import { CronHrEnginesService } from "./cron-hr-engines.service";
import { CronKbService } from "./cron-kb.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronLeaveResetService } from "./cron-leave-reset.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronProjectsService } from "./cron-projects.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { CronEmailOutboxService } from "./cron-email-outbox.service";
import { CronSupportService } from "./cron-support.service";
import { CronCrmTasksService } from "./cron-crm-tasks.service";
import { CronCrmLifecycleService } from "./cron-crm-lifecycle.service";
import { CronCrmAutonomyService } from "./cron-crm-autonomy.service";
import { RelationshipsModule } from "../relationships/relationships.module";
import { AutonomyModule } from "../autonomy/autonomy.module";
import { AutonomySequencesModule } from "../autonomy/sequences/autonomy-sequences.module";
import { LifecycleTriggersModule } from "../lifecycle/lifecycle-triggers.module";
import { CronIdempotencyService } from "./cron-idempotency.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronHrRetentionService } from "./cron-hr-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronKbChunkRetentionService } from "./cron-kb-chunk-retention.service";
import { CronKbChatRetentionService } from "./cron-kb-chat-retention.service";
import { CronKbTelemetryRetentionService } from "./cron-kb-telemetry-retention.service";
import { CronOrganizationService } from "./cron-organization.service";
import { CronOrgPurgeWorkerService } from "./cron-org-purge-worker.service";
import { CronLeaseService } from "./cron-lease.service";
import { CronAiUsageRetentionService } from "./cron-ai-usage-retention.service";
import { ProjectsModule } from "../build/core/projects.module";
import { CrmModule } from "../crm/core/crm.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { SessionsModule } from "../sessions/sessions.module";
import { EmploymentFactsModule } from "../directory/employment-facts.module";
import { CalendarModule } from "../calendar/calendar.module";
import { PlatformModule } from "../platform/platform.module";
import { CronOperatorAccessService } from "./cron-operator-access.service";
import { CronHelpdeskRetentionService } from "./cron-helpdesk-retention.service";
import { CronMailRetentionService } from "./cron-mail-retention.service";
import { CronAnnouncementsRetentionService } from "./cron-announcements-retention.service";
import { CronStorageSweepService } from "./cron-storage-sweep.service";
import { CronStorageController } from "./cron-storage.controller";
import { CronOutboxRetentionService } from "./cron-outbox-retention.service";
import { CronNotificationOutboxRetentionService } from "./cron-notification-outbox-retention.service";
import { CronRetentionSchedulerService } from "./cron-retention-scheduler.service";
import { CronOutboxWorkerService } from "./cron-outbox-worker.service";
import { CronSweepFailureSinkService } from "./cron-sweep-failure-sink.service";
import { CronGdprExportRetentionService } from "./cron-gdpr-export-retention.service";
import { CronHrDocumentsService } from "./cron-hr-documents.service";
import { CronPlatformRetentionController } from "./cron-platform-retention.controller";

@Module({
  imports: [
    EmploymentFactsModule,
    CalendarModule,
    AutomationModule,
    AiModule,
    AiJobsModule,
    SupportKbGapModule,
    EmailModule,
    ChatModule,
    KbModule,
    SupportModule,
    NotificationsModule,
    OwnershipModule,
    HrAutomationsModule,
    HrTimeModule,
    HrHelpdeskModule,
    HrWorkflowsModule,
    HrCoreModule,
    HrLifecycleModule,
    LifecycleTriggersModule,
    RelationshipsModule,
    AutonomyModule,
    AutonomySequencesModule,
    HrGlobalModule,
    InvoicesModule,
    FeedbucketModule,
    CrmAutomationStudioModule,
    BillingModule,
    TimesheetsCoreModule,
    ESignModule,
    OrganizationModule,
    HrGovernanceModule,
    ProjectsModule,
    CrmModule,
    /** For the report-schedule sweep, which claims due rows and emits. */
    ReportingModule,
    DealsModule,
    OutboxModule,
    SessionsModule,
    PlatformModule,
  ],
  controllers: [
    CronBillingController,
    CronHrController,
    CronHrNotificationsController,
    CronPlatformController,
    CronPlatformRetentionController,
    CronCalendarController,
    CronGdprController,
    CronNotificationsController,
    CronNotificationRetentionController,
    CronOutboxController,
    CronSignController,
    CronSupportController,
    CronKbController,
    CronBuildController,
    CronInvitationExpiryController,
    CronStorageController,
  ],
  providers: [
    CronAttendanceService,
    CronBillingService,
    CronInvitationExpiryService,
    CronWorkflowService,
    CronLeaveService,
    CronLeaveResetService,
    CronNotificationsService,
    CronHolidayService,
    CronKbService,
    CronProjectsService,
    CronRecruitmentService,
    CronHrService,
    CronHrDocumentsService,
    CronHrEnginesService,
    CronWeeklyRecapService,
    CronEmailOutboxService,
    CronSupportService,
    CronNotificationDeliveryService,
    CronNotificationRetentionService,
    NotificationRetentionService,
    PartitionMaintenanceService,
    CronCrmTasksService,
    CronCrmLifecycleService,
    CronCrmAutonomyService,
    CronCrmForecastService,
    CronIdempotencyService,
    CronBuildRetentionService,
    CronHrRetentionService,
    CronBuildSnapshotsService,
    CronKbChunkRetentionService,
    CronKbChatRetentionService,
    CronKbTelemetryRetentionService,
    CronOrganizationService,
    CronOrgPurgeWorkerService,
    CronLeaseService,
    CronAiUsageRetentionService,
    CronOperatorAccessService,
    CronHelpdeskRetentionService,
    CronMailRetentionService,
    CronAnnouncementsRetentionService,
    CronStorageSweepService,
    CronOutboxRetentionService,
    CronNotificationOutboxRetentionService,
    CronGdprExportRetentionService,
    CronSweepFailureSinkService,
    CronRetentionSchedulerService,
    CronOutboxWorkerService,
  ],
})
export class CronModule {}
