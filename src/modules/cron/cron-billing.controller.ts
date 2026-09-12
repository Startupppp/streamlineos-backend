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
import {
  trialExpirySweepResponseSchema,
  monthlyPlanGrantsResponseSchema,
  aiReservationsSweepResponseSchema,
  autoTopUpFlushResponseSchema,
  providerWebhookRedriveResponseSchema,
  aiJobsFlushResponseSchema,
  periodExpirySweepResponseSchema,
} from "./dto/cron-billing-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronBillingController {
  constructor(
    private readonly billing: CronBillingService,
    private readonly aiJobsWorker: AiJobsWorkerService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("trial-expiry")
  @ResponseSchema(trialExpirySweepResponseSchema)
  getTrialExpiry(@Headers("authorization") authorization?: string) {
    return this.runTrialExpiry(authorization);
  }

  @Post("trial-expiry")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(trialExpirySweepResponseSchema)
  postTrialExpiry(@Headers("authorization") authorization?: string) {
    return this.runTrialExpiry(authorization);
  }

  @Get("monthly-plan-grants")
  @ResponseSchema(monthlyPlanGrantsResponseSchema)
  getMonthlyPlanGrants(@Headers("authorization") authorization?: string) {
    return this.runMonthlyPlanGrants(authorization);
  }

  @Post("monthly-plan-grants")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(monthlyPlanGrantsResponseSchema)
  postMonthlyPlanGrants(@Headers("authorization") authorization?: string) {
    return this.runMonthlyPlanGrants(authorization);
  }

  @Get("ai-reservations-sweep")
  @ResponseSchema(aiReservationsSweepResponseSchema)
  getAiReservationsSweep(@Headers("authorization") authorization?: string) {
    return this.runAiReservationsSweep(authorization);
  }

  @Post("ai-reservations-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(aiReservationsSweepResponseSchema)
  postAiReservationsSweep(@Headers("authorization") authorization?: string) {
    return this.runAiReservationsSweep(authorization);
  }

  @Get("auto-topup-flush")
  @ResponseSchema(autoTopUpFlushResponseSchema)
  getAutoTopUpFlush(@Headers("authorization") authorization?: string) {
    return this.runAutoTopUpFlush(authorization);
  }

  @Post("auto-topup-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(autoTopUpFlushResponseSchema)
  postAutoTopUpFlush(@Headers("authorization") authorization?: string) {
    return this.runAutoTopUpFlush(authorization);
  }

  @Get("provider-webhook-redrive")
  @ResponseSchema(providerWebhookRedriveResponseSchema)
  getProviderWebhookRedrive(@Headers("authorization") authorization?: string) {
    return this.runProviderWebhookRedrive(authorization);
  }

  @Post("provider-webhook-redrive")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(providerWebhookRedriveResponseSchema)
  postProviderWebhookRedrive(@Headers("authorization") authorization?: string) {
    return this.runProviderWebhookRedrive(authorization);
  }

  @Get("ai-jobs-flush")
  @ResponseSchema(aiJobsFlushResponseSchema)
  getAiJobsFlush(@Headers("authorization") authorization?: string) {
    return this.runAiJobsFlush(authorization);
  }

  @Post("ai-jobs-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(aiJobsFlushResponseSchema)
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

  @Get("period-expiry")
  @ResponseSchema(periodExpirySweepResponseSchema)
  getPeriodExpiry(@Headers("authorization") authorization?: string) {
    return this.runPeriodExpiry(authorization);
  }

  @Post("period-expiry")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(periodExpirySweepResponseSchema)
  postPeriodExpiry(@Headers("authorization") authorization?: string) {
    return this.runPeriodExpiry(authorization);
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

  private async runPeriodExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("period-expiry", 300, () =>
        this.billing.processPeriodExpiry(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "period-expiry already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Period expiry sweep: ${result.expired} expired, ${result.notified} notified`,
        ...result,
      };
    } catch (error) {
      logger.error("Period expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
