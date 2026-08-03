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
import { CronBillingService } from "./cron-billing.service";
import { AiJobsWorkerService } from "../ai/jobs/ai-jobs-worker.service";

@Public()
@Controller("cron")
export class CronBillingController {
  constructor(
    private readonly billing: CronBillingService,
    private readonly aiJobsWorker: AiJobsWorkerService,
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

  @Get("monthly-plan-grants")
  getMonthlyPlanGrants(@Headers("authorization") authorization?: string) {
    return this.runMonthlyPlanGrants(authorization);
  }

  @Post("monthly-plan-grants")
  @HttpCode(200)
  postMonthlyPlanGrants(@Headers("authorization") authorization?: string) {
    return this.runMonthlyPlanGrants(authorization);
  }

  @Get("ai-reservations-sweep")
  getAiReservationsSweep(@Headers("authorization") authorization?: string) {
    return this.runAiReservationsSweep(authorization);
  }

  @Post("ai-reservations-sweep")
  @HttpCode(200)
  postAiReservationsSweep(@Headers("authorization") authorization?: string) {
    return this.runAiReservationsSweep(authorization);
  }

  @Get("auto-topup-flush")
  getAutoTopUpFlush(@Headers("authorization") authorization?: string) {
    return this.runAutoTopUpFlush(authorization);
  }

  @Post("auto-topup-flush")
  @HttpCode(200)
  postAutoTopUpFlush(@Headers("authorization") authorization?: string) {
    return this.runAutoTopUpFlush(authorization);
  }

  @Get("ai-jobs-flush")
  getAiJobsFlush(@Headers("authorization") authorization?: string) {
    return this.runAiJobsFlush(authorization);
  }

  @Post("ai-jobs-flush")
  @HttpCode(200)
  postAiJobsFlush(@Headers("authorization") authorization?: string) {
    return this.runAiJobsFlush(authorization);
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

  private async runMonthlyPlanGrants(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.billing.processMonthlyPlanGrants();
      return {
        success: true,
        message: `Monthly plan grants: ${result.granted} granted, ${result.skipped} skipped`,
        ...result,
      };
    } catch (error) {
      logger.error("Monthly plan grants cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAiReservationsSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.billing.sweepAiReservations();
      return {
        success: true,
        message: `Released ${result.released} expired AI credit reservations`,
        ...result,
      };
    } catch (error) {
      logger.error("AI reservations sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAutoTopUpFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.billing.processAutoTopUps();
      return {
        success: true,
        message: `Auto top-up flush: ${result.topped} topped, ${result.skipped} skipped, ${result.failed} failed`,
        ...result,
      };
    } catch (error) {
      logger.error("Auto top-up flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAiJobsFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.aiJobsWorker.flush();
      return {
        success: true,
        message: `AI jobs flush: ${result.claimed} claimed, ${result.completed} completed, ${result.failed} failed`,
        ...result,
      };
    } catch (error) {
      logger.error("AI jobs flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
