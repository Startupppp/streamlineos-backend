/*
  The four finance modules and `CronFinanceService` are absent deliberately.

  They belonged to `modules/finance`, which the accounting rewrite replaced with
  the `gl_*` kernel; the scheduled work they registered has no counterpart there
  yet. Everything else main schedules is registered exactly as before.
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
import { HrWorkflowsModule } from "../hr/workflows/hr-workflows.module";
import { HrCoreModule } from "../hr/core/hr-core.module";
import { HrLifecycleModule } from "../hr/lifecycle/hr-lifecycle.module";
import { HrGlobalModule } from "../hr/global/hr-global.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { AiJobsModule } from "../ai/jobs/ai-jobs.module";
import { SupportKbGapModule } from "../support/kb-gap";
import { TimesheetsCoreModule } from "../timesheets/core/timesheets-core.module";
import { OrganizationModule } from "../organization/core/organization.module";
import { CronBillingController } from "./cron-billing.controller";
import { CronInvitationExpiryController } from "./cron-invitation-expiry.controller";
import { CronHrController } from "./cron-hr.controller";
import { CronPlatformController } from "./cron-platform.controller";
import { CronOutboxController } from "./cron-outbox.controller";
import { CronSupportController } from "./cron-support.controller";
import { CronBuildController } from "./cron-build.controller";
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { CronNotificationRetentionService } from "./cron-notification-retention.service";
import { NotificationRetentionService } from "../notifications/notification-retention.service";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronBillingService } from "./cron-billing.service";
import { CronInvitationExpiryService } from "./cron-invitation-expiry.service";
import { CronWorkflowService } from "./cron-workflow.service";
import { CronHolidayService } from "./cron-holiday.service";
import { CronHrService } from "./cron-hr.service";
import { CronHrEnginesService } from "./cron-hr-engines.service";
import { CronKbService } from "./cron-kb.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronProjectsService } from "./cron-projects.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { CronEmailOutboxService } from "./cron-email-outbox.service";
import { CronSupportService } from "./cron-support.service";
import { CronCrmTasksService } from "./cron-crm-tasks.service";
import { CronCrmLifecycleService } from "./cron-crm-lifecycle.service";
import { LifecycleTriggersModule } from "../lifecycle/lifecycle-triggers.module";
import { CronIdempotencyService } from "./cron-idempotency.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronKbChunkRetentionService } from "./cron-kb-chunk-retention.service";
import { CronOrganizationService } from "./cron-organization.service";
import { CronOrgPurgeWorkerService } from "./cron-org-purge-worker.service";
import { CronLeaseService } from "./cron-lease.service";
import { ProjectsModule } from "../build/core/projects.module";
import { CrmModule } from "../crm/core/crm.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { SessionsModule } from "../sessions/sessions.module";
import { EmploymentFactsModule } from "../directory/employment-facts.module";

@Module({
  imports: [
    EmploymentFactsModule,
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
    HrWorkflowsModule,
    HrCoreModule,
    HrLifecycleModule,
    LifecycleTriggersModule,
    HrGlobalModule,
    InvoicesModule,
    CrmAutomationStudioModule,
    BillingModule,
    TimesheetsCoreModule,
    OrganizationModule,
    ProjectsModule,
    CrmModule,
    OutboxModule,
    SessionsModule,
  ],
  controllers: [
    CronBillingController,
    CronHrController,
    CronPlatformController,
    CronOutboxController,
    CronSupportController,
    CronBuildController,
    CronInvitationExpiryController,
  ],
  providers: [
    CronAttendanceService,
    CronBillingService,
    CronInvitationExpiryService,
    CronWorkflowService,
    CronLeaveService,
    CronNotificationsService,
    CronHolidayService,
    CronKbService,
    CronProjectsService,
    CronRecruitmentService,
    CronHrService,
    CronHrEnginesService,
    CronWeeklyRecapService,
    CronEmailOutboxService,
    CronSupportService,
    CronNotificationDeliveryService,
    CronNotificationRetentionService,
    NotificationRetentionService,
    CronCrmTasksService,
    CronCrmLifecycleService,
    CronIdempotencyService,
    CronBuildRetentionService,
    CronBuildSnapshotsService,
    CronKbChunkRetentionService,
    CronOrganizationService,
    CronOrgPurgeWorkerService,
    CronLeaseService,
  ],
})
export class CronModule {}
