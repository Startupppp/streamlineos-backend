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
import { CronLeaseService } from "./cron-lease.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const sweepNameParams = z.object({ sweepName: z.string().min(1) }).strict();

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
    private readonly cronLease: CronLeaseService,
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

  @Get("weekly-exec-recap")
  getWeeklyExecRecap(@Headers("authorization") authorization?: string) {
    return this.runWeeklyExecRecap(authorization);
  }

  @Post("weekly-exec-recap")
  @HttpCode(200)
  postWeeklyExecRecap(@Headers("authorization") authorization?: string) {
    return this.runWeeklyExecRecap(authorization);
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
  @Validate({ params: sweepNameParams })
  postHrEnginesSweepByName(
    @Headers("authorization") authorization?: string,
    @Param("sweepName") sweepName?: string,
  ) {
    return this.runHrEnginesSweepByName(authorization, sweepName);
  }

  @Get("hr-engines-sweep/:sweepName")
  @Validate({ params: sweepNameParams })
  getHrEnginesSweepByName(
    @Headers("authorization") authorization?: string,
    @Param("sweepName") sweepName?: string,
  ) {
    return this.runHrEnginesSweepByName(authorization, sweepName);
  }

  private async runAutoCheckout(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("auto-checkout", 300, () =>
        this.attendance.processAutoCheckout(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "auto-checkout already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Auto-checkout cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runMonthlyLeaveReset(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("monthly-leave-reset", 300, () =>
        this.leave.runMonthlyLeaveReset(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "monthly-leave-reset already running" };
      const result = outcome.result;
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

  private async runInterviewNoShows(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("interview-no-shows", 300, () =>
        this.recruitment.processInterviewNoShows(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "interview-no-shows already running" };
      const result = outcome.result;
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

  private async runOnboardingSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("onboarding-sweep", 300, () =>
        this.hr.processOnboardingCompletionSweep(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "onboarding-sweep already running" };
      const result = outcome.result;
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

  private async runHrEnginesSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("hr-engines-sweep", 600, () =>
        this.hrEngines.runAll(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "hr-engines-sweep already running" };
      const result = outcome.result;
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
        const outcome = await this.cronLease.withLease(
          `hr-engines-sweep.workflow-sla`,
          300,
          () => this.hrEngines.sweepWorkflowSlaEscalations(),
        );
        if (!outcome.ran) return { success: true, skipped: true, message: "hr-engines-sweep/workflow-sla already running" };
        return {
          success: true,
          message: `Swept ${outcome.result.swept} overdue workflow steps`,
          ...outcome.result,
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
