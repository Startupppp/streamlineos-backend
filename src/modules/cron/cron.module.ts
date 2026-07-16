import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { AiModule } from "../ai/ai.module";
import { CrmAutomationStudioModule } from "../crm-automation-studio/crm-automation-studio.module";
import { AutomationModule } from "../automation/automation.module";
import { ChatModule } from "../chat/chat.module";
import { EmailModule } from "../email/email.module";
import { KbModule } from "../kb/kb.module";
import { SupportModule } from "../support/support.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { HrTimeModule } from "../hr-time/hr-time.module";
import { HrWorkflowsModule } from "../hr-workflows/hr-workflows.module";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrLifecycleModule } from "../hr-lifecycle/hr-lifecycle.module";
import { HrGlobalModule } from "../hr-global/hr-global.module";
import { AccountingGlModule } from "../accounting-gl/accounting-gl.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { FinanceArModule } from "../finance-ar/finance-ar.module";
import { FinanceApModule } from "../finance-ap/finance-ap.module";
import { FinanceTaxModule } from "../finance-tax/finance-tax.module";
import { FinanceAssetsModule } from "../finance-assets/finance-assets.module";
import { CronController } from "./cron.controller";
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronBillingService } from "./cron-billing.service";
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
import { CronFinanceService } from "./cron-finance.service";
import { CronCrmTasksService } from "./cron-crm-tasks.service";

@Module({
  imports: [AutomationModule, AiModule, EmailModule, ChatModule, KbModule, SupportModule, NotificationsModule, HrAutomationsModule, HrTimeModule, HrWorkflowsModule, HrCoreModule, HrLifecycleModule, HrGlobalModule, AccountingGlModule, InvoicesModule, FinanceArModule, FinanceApModule, FinanceTaxModule, FinanceAssetsModule, CrmAutomationStudioModule, BillingModule],
  controllers: [CronController],
  providers: [
    CronAttendanceService,
    CronBillingService,
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
    CronFinanceService,
    CronCrmTasksService,
  ],
})
export class CronModule {}
