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
import { CronLeaseService } from "./cron-lease.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronBillingController {
  constructor(
    private readonly billing: CronBillingService,
    private readonly aiJobsWorker: AiJobsWorkerService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("trial-expiry")
  getTrialExpiry(@Headers("authorization") authorization?: string) {
    return this.runTrialExpiry(authorization);
  }

  @Post("trial-expiry")
  @BodylessAction()
  @HttpCode(200)
  postTrialExpiry(@Headers("authorization") authorization?: string) {
    return this.runTrialExpiry(authorization);
  }

  @Get("monthly-plan-grants")
  getMonthlyPlanGrants(@Headers("authorization") authorization?: string) {
    return this.runMonthlyPlanGrants(authorization);
  }

  @Post("monthly-plan-grants")
  @BodylessAction()
  @HttpCode(200)
  postMonthlyPlanGrants(@Headers("authorization") authorization?: string) {
    return this.runMonthlyPlanGrants(authorization);
  }

  @Get("ai-reservations-sweep")
  getAiReservationsSweep(@Headers("authorization") authorization?: string) {
    return this.runAiReservationsSweep(authorization);
  }

  @Post("ai-reservations-sweep")
  @BodylessAction()
  @HttpCode(200)
  postAiReservationsSweep(@Headers("authorization") authorization?: string) {
    return this.runAiReservationsSweep(authorization);
  }

  @Get("auto-topup-flush")
  getAutoTopUpFlush(@Headers("authorization") authorization?: string) {
    return this.runAutoTopUpFlush(authorization);
  }

  @Post("auto-topup-flush")
  @BodylessAction()
  @HttpCode(200)
  postAutoTopUpFlush(@Headers("authorization") authorization?: string) {
    return this.runAutoTopUpFlush(authorization);
  }

  @Get("provider-webhook-redrive")
  getProviderWebhookRedrive(@Headers("authorization") authorization?: string) {
    return this.runProviderWebhookRedrive(authorization);
  }

  @Post("provider-webhook-redrive")
  @BodylessAction()
  @HttpCode(200)
  postProviderWebhookRedrive(@Headers("authorization") authorization?: string) {
    return this.runProviderWebhookRedrive(authorization);
  }

  @Get("ai-jobs-flush")
  getAiJobsFlush(@Headers("authorization") authorization?: string) {
    return this.runAiJobsFlush(authorization);
  }

  @Post("ai-jobs-flush")
  @BodylessAction()
  @HttpCode(200)
  postAiJobsFlush(@Headers("authorization") authorization?: string) {
    return this.runAiJobsFlush(authorization);
  }

  private async runTrialExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("trial-expiry", 300, () =>
        this.billing.processTrialExpiry(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "trial-expiry already running" };
      const result = outcome.result;
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
      const outcome = await this.cronLease.withLease("monthly-plan-grants", 300, () =>
        this.billing.processMonthlyPlanGrants(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "monthly-plan-grants already running" };
      const result = outcome.result;
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
      const outcome = await this.cronLease.withLease("ai-reservations-sweep", 120, () =>
        this.billing.sweepAiReservations(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "ai-reservations-sweep already running" };
      const result = outcome.result;
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
      const outcome = await this.cronLease.withLease("auto-topup-flush", 120, () =>
        this.billing.processAutoTopUps(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "auto-topup-flush already running" };
      const result = outcome.result;
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

  private async runProviderWebhookRedrive(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("provider-webhook-redrive", 300, () =>
        this.billing.redriveStuckProviderEvents(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "provider-webhook-redrive already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Provider webhook redrive: ${result.attempted} attempted, ${result.recovered} recovered, ${result.failed} failed`,
        ...result,
      };
    } catch (error) {
      logger.error("Provider webhook redrive cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAiJobsFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("ai-jobs-flush", 120, () =>
        this.aiJobsWorker.flush(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "ai-jobs-flush already running" };
      const result = outcome.result;
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
