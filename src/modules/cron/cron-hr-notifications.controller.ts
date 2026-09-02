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
import { CronNotificationsService } from "./cron-notifications.service";
import { CronHolidayService } from "./cron-holiday.service";
import { CronHrService } from "./cron-hr.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { CronLeaseService } from "./cron-lease.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronHrNotificationsController {
  constructor(
    private readonly notifications: CronNotificationsService,
    private readonly holiday: CronHolidayService,
    private readonly recruitment: CronRecruitmentService,
    private readonly hr: CronHrService,
    private readonly weeklyRecap: CronWeeklyRecapService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("daily-notifications")
  getDailyNotifications(@Headers("authorization") authorization?: string) {
    return this.runDailyNotifications(authorization);
  }

  @Post("daily-notifications")
  @BodylessAction()
  @HttpCode(200)
  postDailyNotifications(@Headers("authorization") authorization?: string) {
    return this.runDailyNotifications(authorization);
  }

  @Get("holiday-notifications")
  getHolidayNotifications(@Headers("authorization") authorization?: string) {
    return this.runHolidayNotifications(authorization);
  }

  @Post("holiday-notifications")
  @BodylessAction()
  @HttpCode(200)
  postHolidayNotifications(@Headers("authorization") authorization?: string) {
    return this.runHolidayNotifications(authorization);
  }

  @Get("offer-deadline-reminders")
  getOfferDeadlineReminders(@Headers("authorization") authorization?: string) {
    return this.runOfferDeadlineReminders(authorization);
  }

  @Post("offer-deadline-reminders")
  @BodylessAction()
  @HttpCode(200)
  postOfferDeadlineReminders(@Headers("authorization") authorization?: string) {
    return this.runOfferDeadlineReminders(authorization);
  }

  @Get("certification-expiry")
  getCertificationExpiry(@Headers("authorization") authorization?: string) {
    return this.runCertificationExpiry(authorization);
  }

  @Post("certification-expiry")
  @BodylessAction()
  @HttpCode(200)
  postCertificationExpiry(@Headers("authorization") authorization?: string) {
    return this.runCertificationExpiry(authorization);
  }

  @Get("weekly-exec-recap")
  getWeeklyExecRecap(@Headers("authorization") authorization?: string) {
    return this.runWeeklyExecRecap(authorization);
  }

  @Post("weekly-exec-recap")
  @BodylessAction()
  @HttpCode(200)
  postWeeklyExecRecap(@Headers("authorization") authorization?: string) {
    return this.runWeeklyExecRecap(authorization);
  }

  @Get("document-expiry")
  getDocumentExpiry(@Headers("authorization") authorization?: string) {
    return this.runDocumentExpiry(authorization);
  }

  @Post("document-expiry")
  @BodylessAction()
  @HttpCode(200)
  postDocumentExpiry(@Headers("authorization") authorization?: string) {
    return this.runDocumentExpiry(authorization);
  }

  private async runDailyNotifications(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("daily-notifications", 300, () =>
        this.notifications.sendDailyNotifications(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "daily-notifications already running" };
      const result = outcome.result;
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
      const outcome = await this.cronLease.withLease("holiday-notifications", 300, () =>
        this.holiday.sendHolidayNotifications(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "holiday-notifications already running" };
      const result = outcome.result;
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

  private async runOfferDeadlineReminders(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("offer-deadline-reminders", 300, () =>
        this.recruitment.sendOfferDeadlineReminders(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "offer-deadline-reminders already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Sent ${result.remindedCount} offer deadline reminders`,
        ...result,
      };
    } catch (error) {
      logger.error("Offer deadline reminder cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runCertificationExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("certification-expiry", 300, () =>
        this.hr.processCertificationExpiry(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "certification-expiry already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Processed ${result.fired} certification expiry reminders`,
        ...result,
      };
    } catch (error) {
      logger.error("Certification expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runWeeklyExecRecap(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("weekly-exec-recap", 600, () =>
        this.weeklyRecap.sendWeeklyExecRecaps(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "weekly-exec-recap already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Weekly FINAL recap cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runDocumentExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("document-expiry", 300, () =>
        this.hr.processDocumentExpiry(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "document-expiry already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Processed ${result.fired} document expiry reminders`,
        ...result,
      };
    } catch (error) {
      logger.error("Document expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
