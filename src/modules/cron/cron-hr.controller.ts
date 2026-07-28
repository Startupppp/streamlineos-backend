import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Param,
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
import { CronHrEnginesService } from "./cron-hr-engines.service";
import { CronRecruitmentService } from "./cron-recruitment.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";

@Public()
@Controller("cron")
export class CronHrController {
  constructor(
    private readonly attendance: CronAttendanceService,
    private readonly leave: CronLeaveService,
    private readonly notifications: CronNotificationsService,
    private readonly holiday: CronHolidayService,
    private readonly recruitment: CronRecruitmentService,
    private readonly hr: CronHrService,
    private readonly hrEngines: CronHrEnginesService,
    private readonly weeklyRecap: CronWeeklyRecapService,
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

  @Get("document-expiry")
  getDocumentExpiry(@Headers("authorization") authorization?: string) {
    return this.runDocumentExpiry(authorization);
  }

  @Post("document-expiry")
  @HttpCode(200)
  postDocumentExpiry(@Headers("authorization") authorization?: string) {
    return this.runDocumentExpiry(authorization);
  }

  @Post("hr-engines-sweep")
  @HttpCode(200)
  postHrEnginesSweep(@Headers("authorization") authorization?: string) {
    return this.runHrEnginesSweep(authorization);
  }

  @Get("hr-engines-sweep")
  getHrEnginesSweep(@Headers("authorization") authorization?: string) {
    return this.runHrEnginesSweep(authorization);
  }

  @Post("hr-engines-sweep/:sweepName")
  @HttpCode(200)
  postHrEnginesSweepByName(
    @Headers("authorization") authorization?: string,
    @Param("sweepName") sweepName?: string,
  ) {
    return this.runHrEnginesSweepByName(authorization, sweepName);
  }

  @Get("hr-engines-sweep/:sweepName")
  getHrEnginesSweepByName(
    @Headers("authorization") authorization?: string,
    @Param("sweepName") sweepName?: string,
  ) {
    return this.runHrEnginesSweepByName(authorization, sweepName);
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
      return {
        success: true,
        monthlyExpiry: result.monthlyExpiry,
        yearlyReset: result.yearlyReset,
      };
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

  private async runCertificationExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hr.processCertificationExpiry();
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

  private async runOnboardingSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hr.processOnboardingCompletionSweep();
      return {
        success: true,
        message: `Dispatched ${result.fired} onboarding completion events`,
        ...result,
      };
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

  private async runDocumentExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hr.processDocumentExpiry();
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

  private async runHrEnginesSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.hrEngines.runAll();
      return {
        success: true,
        message: `HR engines sweep complete: ${result.succeeded} succeeded, ${result.failed} failed across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("HR engines sweep (all) cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runHrEnginesSweepByName(
    authorization?: string,
    sweepName?: string,
  ) {
    assertCronSecret(authorization);
    try {
      if (sweepName === "workflow-sla") {
        const result = await this.hrEngines.sweepWorkflowSlaEscalations();
        return {
          success: true,
          message: `Swept ${result.swept} overdue workflow steps`,
          ...result,
        };
      }
      return {
        success: false,
        message: `Unknown sweep name: ${sweepName ?? ""}`,
      };
    } catch (error) {
      logger.error(
        `HR engines sweep (${sweepName ?? "unknown"}) cron failed`,
        error,
      );
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
