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
import { CronBillingService } from "./cron-billing.service";
import { CronWeeklyRecapService } from "./cron-weekly-recap.service";
import { CronEmailOutboxService } from "./cron-email-outbox.service";
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { CronProjectsService } from "./cron-projects.service";
import { ChatReplyRemindersService } from "../chat/chat-reply-reminders.service";
import { CronKbService } from "./cron-kb.service";
import { CronSupportService } from "./cron-support.service";

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
    private readonly hrEngines: CronHrEnginesService,
    private readonly weeklyRecap: CronWeeklyRecapService,
    private readonly emailOutbox: CronEmailOutboxService,
    private readonly notificationDelivery: CronNotificationDeliveryService,
    private readonly cronProjects: CronProjectsService,
    private readonly kb: CronKbService,
    private readonly support: CronSupportService,
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

  @Get("notification-delivery-flush")
  getNotificationDeliveryFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDeliveryFlush(authorization);
  }

  @Post("notification-delivery-flush")
  @HttpCode(200)
  postNotificationDeliveryFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDeliveryFlush(authorization);
  }

  private async runNotificationDeliveryFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.notificationDelivery.flush();
      return {
        success: true,
        message: `Processed ${result.processed} deliveries: ${result.sent} sent, ${result.failed} retrying, ${result.dead} dead`,
        ...result,
      };
    } catch (error) {
      logger.error("Notification delivery flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("support-sla-escalations")
  getSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Post("support-sla-escalations")
  @HttpCode(200)
  postSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  private async runSupportSlaEscalations(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.support.runSlaEscalations();
      return {
        success: true,
        message: `Checked ${result.checked} tickets across ${result.orgsProcessed} orgs, escalated ${result.escalated}`,
        ...result,
      };
    } catch (error) {
      logger.error("Support SLA escalation cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("support-unsnooze")
  getSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Post("support-unsnooze")
  @HttpCode(200)
  postSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  private async runSupportUnsnooze(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.support.runUnsnooze();
      return { success: true, message: `Unsnoozed ${result.unsnoozed} tickets`, ...result };
    } catch (error) {
      logger.error("Support unsnooze cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("projects-recurring-flush")
  getProjectsRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runProjectsRecurringFlush(authorization);
  }

  @Post("projects-recurring-flush")
  @HttpCode(200)
  postProjectsRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runProjectsRecurringFlush(authorization);
  }

  private async runProjectsRecurringFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.cronProjects.spawnDueRecurringTickets();
      return {
        success: true,
        message: `Spawned ${result.spawned} recurring tickets, advanced ${result.advanced} schedules`,
        ...result,
      };
    } catch (error) {
      logger.error("Projects recurring flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Get("kb-trash-purge")
  getKbTrashPurge(@Headers("authorization") authorization?: string) {
    return this.runKbTrashPurge(authorization);
  }

  @Post("kb-trash-purge")
  @HttpCode(200)
  postKbTrashPurge(@Headers("authorization") authorization?: string) {
    return this.runKbTrashPurge(authorization);
  }

  private async runKbTrashPurge(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.kb.purgeExpiredTrash();
      return {
        success: true,
        message: `Purged ${result.purgedCount} KB pages across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("KB trash purge cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
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

  private async runHrEnginesSweepByName(authorization?: string, sweepName?: string) {
    assertCronSecret(authorization);
    try {
      if (sweepName === "workflow-sla") {
        const result = await this.hrEngines.sweepWorkflowSlaEscalations();
        return { success: true, message: `Swept ${result.swept} overdue workflow steps`, ...result };
      }
      return { success: false, message: `Unknown sweep name: ${sweepName ?? ""}` };
    } catch (error) {
      logger.error(`HR engines sweep (${sweepName ?? "unknown"}) cron failed`, error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
