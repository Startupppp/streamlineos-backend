import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { assertCronSecret } from "./cron-secret";
import { CronAttendanceService } from "./cron-attendance.service";
import { CronLeaveService } from "./cron-leave.service";
import { CronNotificationsService } from "./cron-notifications.service";
import { CronHolidayService } from "./cron-holiday.service";

@Public()
@Controller("cron")
export class CronController {
  constructor(
    private readonly attendance: CronAttendanceService,
    private readonly leave: CronLeaveService,
    private readonly notifications: CronNotificationsService,
    private readonly holiday: CronHolidayService,
  ) {}

  @Get("auto-checkout")
  getAutoCheckout(@Headers("authorization") authorization?: string) {
    return this.runAutoCheckout(authorization);
  }

  @Post("auto-checkout")
  @HttpCode(200)
  postAutoCheckout(@Headers("authorization") authorization?: string) {
    return this.runAutoCheckout(authorization);
  }

  @Get("monthly-leave-reset")
  getMonthlyLeaveReset(@Headers("authorization") authorization?: string) {
    return this.runMonthlyLeaveReset(authorization);
  }

  @Post("monthly-leave-reset")
  @HttpCode(200)
  postMonthlyLeaveReset(@Headers("authorization") authorization?: string) {
    return this.runMonthlyLeaveReset(authorization);
  }

  @Get("daily-notifications")
  getDailyNotifications(@Headers("authorization") authorization?: string) {
    return this.runDailyNotifications(authorization);
  }

  @Post("daily-notifications")
  @HttpCode(200)
  postDailyNotifications(@Headers("authorization") authorization?: string) {
    return this.runDailyNotifications(authorization);
  }

  @Get("holiday-notifications")
  getHolidayNotifications(@Headers("authorization") authorization?: string) {
    return this.runHolidayNotifications(authorization);
  }

  @Post("holiday-notifications")
  @HttpCode(200)
  postHolidayNotifications(@Headers("authorization") authorization?: string) {
    return this.runHolidayNotifications(authorization);
  }

  private async runAutoCheckout(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.attendance.processAutoCheckout();
      return { success: true, ...result };
    } catch (error) {
      logger.error("Auto-checkout cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runMonthlyLeaveReset(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.leave.runMonthlyLeaveReset();
      return { success: true, monthlyExpiry: result.monthlyExpiry, yearlyReset: result.yearlyReset };
    } catch (error) {
      logger.error("Monthly leave reset cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runDailyNotifications(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.notifications.sendDailyNotifications();
      return {
        success: true,
        message: `Daily notifications sent: ${result.birthdayCount} birthdays, ${result.leaveCount} on-leave, ${result.anniversaryCount} anniversaries`,
        ...result,
      };
    } catch (error) {
      logger.error("Daily notification cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runHolidayNotifications(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.holiday.sendHolidayNotifications();
      if ("error" in result) {
        throw new InternalServerErrorException(result.error);
      }
      return {
        success: true,
        message: `Sent notifications for ${result.count} upcoming holidays`,
        count: result.count,
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      logger.error("Holiday notification cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
