import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { AutomationModule } from "../automation/automation.module";
import { EmailModule } from "../email/email.module";
import { CronController } from "./cron.controller";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronBillingService } from "./cron-billing.service";
import { CronHolidayService } from "./cron-holiday.service";
import { CronHrService } from "./cron-hr.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";

@Module({
  imports: [AutomationModule, AiModule, EmailModule],
  controllers: [CronController],
  providers: [
    CronAttendanceService,
    CronBillingService,
    CronLeaveService,
    CronNotificationsService,
    CronHolidayService,
    CronRecruitmentService,
    CronHrService,
    CronWeeklyRecapService,
  ],
})
export class CronModule {}
