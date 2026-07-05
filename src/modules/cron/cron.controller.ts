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
import { CronHrService } from "./cron-hr.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronBillingService } from "./cron-billing.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { CronEmailOutboxService } from "./cron-email-outbox.service";
import { ChatReplyRemindersService } from "../chat/chat-reply-reminders.service";

@Public()
@Controller("cron")
export class CronController {
  constructor(
    private readonly attendance: CronAttendanceService,
    private readonly billing: CronBillingService,
    private readonly leave: CronLeaveService,
    private readonly notifications: CronNotificationsService,
    private readonly holiday: CronHolidayService,
    private readonly recruitment: CronRecruitmentService,
    private readonly hr: CronHrService,
    private readonly weeklyRecap: CronWeeklyRecapService,
    private readonly emailOutbox: CronEmailOutboxService,
    private readonly chatReplyReminders: ChatReplyRemindersService,
  ) {}

  @Get("trial-expiry")
  getTrialExpiry(@Headers("authorization") authorization?: string) {
    return this.runTrialExpiry(authorization);
  }

  @Post("trial-expiry")
  @HttpCode(200)
  postTrialExpiry(@Headers("authorization") authorization?: string) {
    return this.runTrialExpiry(authorization);
  }

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

  @Get("offer-deadline-reminders")
  getOfferDeadlineReminders(@Headers("authorization") authorization?: string) {
    return this.runOfferDeadlineReminders(authorization);
  }

  @Post("offer-deadline-reminders")
  @HttpCode(200)
  postOfferDeadlineReminders(@Headers("authorization") authorization?: string) {
    return this.runOfferDeadlineReminders(authorization);
  }

  @Get("interview-no-shows")
  getInterviewNoShows(@Headers("authorization") authorization?: string) {
    return this.runInterviewNoShows(authorization);
  }

  @Post("interview-no-shows")
  @HttpCode(200)
  postInterviewNoShows(@Headers("authorization") authorization?: string) {
    return this.runInterviewNoShows(authorization);
  }

  private async runTrialExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.billing.processTrialExpiry();
      return {
        success: true,
        message: `Expired ${result.expired} trials, sent ${result.reminded} reminders`,
        ...result,
      };
    } catch (error) {
      logger.error("Trial expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
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

  private async runOfferDeadlineReminders(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.recruitment.sendOfferDeadlineReminders();
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

  private async runInterviewNoShows(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.recruitment.processInterviewNoShows();
      return {
        success: true,
        message: `Processed ${result.processedCount} interview no-shows`,
        ...result,
      };
    } catch (error) {
      logger.error("Interview no-show cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("certification-expiry")
  getCertificationExpiry(@Headers("authorization") authorization?: string) {
    return this.runCertificationExpiry(authorization);
  }

  @Post("certification-expiry")
  @HttpCode(200)
  postCertificationExpiry(@Headers("authorization") authorization?: string) {
    return this.runCertificationExpiry(authorization);
  }

  @Get("onboarding-sweep")
  getOnboardingSweep(@Headers("authorization") authorization?: string) {
    return this.runOnboardingSweep(authorization);
  }

  @Post("onboarding-sweep")
  @HttpCode(200)
  postOnboardingSweep(@Headers("authorization") authorization?: string) {
    return this.runOnboardingSweep(authorization);
  }

  @Get("weekly-ceo-recap")
  getWeeklyCeoRecap(@Headers("authorization") authorization?: string) {
    return this.runWeeklyCeoRecap(authorization);
  }

  @Post("weekly-ceo-recap")
  @HttpCode(200)
  postWeeklyCeoRecap(@Headers("authorization") authorization?: string) {
    return this.runWeeklyCeoRecap(authorization);
  }

  private async runCertificationExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hr.processCertificationExpiry();
      return { success: true, message: `Processed ${result.fired} certification expiry reminders`, ...result };
    } catch (error) {
      logger.error("Certification expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runOnboardingSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hr.processOnboardingCompletionSweep();
      return { success: true, message: `Dispatched ${result.fired} onboarding completion events`, ...result };
    } catch (error) {
      logger.error("Onboarding completion sweep failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runWeeklyCeoRecap(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.weeklyRecap.sendWeeklyCeoRecaps();
      return { success: true, ...result };
    } catch (error) {
      logger.error("Weekly CEO recap cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("document-expiry")
  getDocumentExpiry(@Headers("authorization") authorization?: string) {
    return this.runDocumentExpiry(authorization);
  }

  @Post("document-expiry")
  @HttpCode(200)
  postDocumentExpiry(@Headers("authorization") authorization?: string) {
    return this.runDocumentExpiry(authorization);
  }

  private async runDocumentExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hr.processDocumentExpiry();
      return { success: true, message: `Processed ${result.fired} document expiry reminders`, ...result };
    } catch (error) {
      logger.error("Document expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("chat-reply-reminders")
  getChatReplyReminders(@Headers("authorization") authorization?: string) {
    return this.runChatReplyReminders(authorization);
  }

  @Post("chat-reply-reminders")
  @HttpCode(200)
  postChatReplyReminders(@Headers("authorization") authorization?: string) {
    return this.runChatReplyReminders(authorization);
  }

  private async runChatReplyReminders(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.chatReplyReminders.processDueReminders();
      return {
        success: true,
        message: `Sent ${result.sent} chat reply reminders, cancelled ${result.cancelled}`,
        ...result,
      };
    } catch (error) {
      logger.error("Chat reply reminder cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("email-outbox-flush")
  getEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Post("email-outbox-flush")
  @HttpCode(200)
  postEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  private async runEmailOutboxFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.emailOutbox.flushOutbox();
      return {
        success: true,
        message: `Processed ${result.processed} outbox emails: ${result.sent} sent, ${result.dead} dead`,
        ...result,
      };
    } catch (error) {
      logger.error("Email outbox flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
