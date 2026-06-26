import { Module } from "@nestjs/common";
import { CronController } from "./cron.controller";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronHolidayService } from "./cron-holiday.service";

@Module({
  controllers: [CronController],
  providers: [
    CronAttendanceService,
    CronLeaveService,
    CronNotificationsService,
    CronHolidayService,
  ],
})
export class CronModule {}
