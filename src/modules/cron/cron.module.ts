import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { AutomationModule } from "../automation/automation.module";
import { ChatModule } from "../chat/chat.module";
import { EmailModule } from "../email/email.module";
import { KbModule } from "../kb/kb.module";
import { SupportModule } from "../support/support.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { HrTimeModule } from "../hr-time/hr-time.module";
import { CronController } from "./cron.controller";
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronBillingService } from "./cron-billing.service";
import { CronHolidayService } from "./cron-holiday.service";
import { CronHrService } from "./cron-hr.service";
import { CronKbService } from "./cron-kb.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronProjectsService } from "./cron-projects.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { CronEmailOutboxService } from "./cron-email-outbox.service";
import { CronSupportService } from "./cron-support.service";

@Module({
  imports: [AutomationModule, AiModule, EmailModule, ChatModule, KbModule, SupportModule, NotificationsModule, HrAutomationsModule, HrTimeModule],
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
    CronWeeklyRecapService,
    CronEmailOutboxService,
    CronSupportService,
    CronNotificationDeliveryService,
  ],
})
export class CronModule {}
