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
import { CronSupportService } from "./cron-support.service";
import { SupportKbGapDetectionService } from "../support/kb-gap/support-kb-gap-detection.service";
import { CronLeaseService } from "./cron-lease.service";
import { SessionsService } from "../sessions/sessions.service";
import {
  supportSlaEscalationsResponseSchema,
  supportUnsnoozeResponseSchema,
  supportKbGapDetectResponseSchema,
  sessionRevocationPruneResponseSchema,
} from "./dto/cron-support-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronSupportController {
  constructor(
    private readonly support: CronSupportService,
    private readonly supportKbGap: SupportKbGapDetectionService,
    private readonly cronLease: CronLeaseService,
    private readonly sessions: SessionsService,
  ) {}

  @Get("support-sla-escalations")
  @ResponseSchema(supportSlaEscalationsResponseSchema)
  getSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Post("support-sla-escalations")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(supportSlaEscalationsResponseSchema)
  postSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Get("support-unsnooze")
  @ResponseSchema(supportUnsnoozeResponseSchema)
  getSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Post("support-unsnooze")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(supportUnsnoozeResponseSchema)
  postSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Get("support-kb-gap-detect")
  @ResponseSchema(supportKbGapDetectResponseSchema)
  getSupportKbGapDetect(@Headers("authorization") authorization?: string) {
    return this.runSupportKbGapDetect(authorization);
  }

  @Post("support-kb-gap-detect")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(supportKbGapDetectResponseSchema)
  postSupportKbGapDetect(@Headers("authorization") authorization?: string) {
    return this.runSupportKbGapDetect(authorization);
  }

  @Get("session-revocation-prune")
  @ResponseSchema(sessionRevocationPruneResponseSchema)
  getSessionRevocationPrune(@Headers("authorization") authorization?: string) {
    return this.runSessionRevocationPrune(authorization);
  }

  @Post("session-revocation-prune")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(sessionRevocationPruneResponseSchema)
  postSessionRevocationPrune(@Headers("authorization") authorization?: string) {
    return this.runSessionRevocationPrune(authorization);
  }

  private async runSupportSlaEscalations(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("support-sla-escalations", 300, () =>
        this.support.runSlaEscalations(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "support-sla-escalations already running" };
      const result = outcome.result;
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

  private async runSupportUnsnooze(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("support-unsnooze", 120, () =>
        this.support.runUnsnooze(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "support-unsnooze already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Unsnoozed ${result.unsnoozed} tickets`,
        ...result,
      };
    } catch (error) {
      logger.error("Support unsnooze cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runSupportKbGapDetect(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("support-kb-gap-detect", 600, () =>
        this.supportKbGap.runDetectAllOrgs(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "support-kb-gap-detect already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Support KB gap detect: processed ${result.processed} orgs, ${result.errors} errors`,
        ...result,
      };
    } catch (error) {
      logger.error("Support KB gap detect cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runSessionRevocationPrune(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("session-revocation-prune", 120, () =>
        this.sessions.pruneExpiredRevocations(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "session-revocation-prune already running" };
      return {
        success: true,
        message: `Pruned ${outcome.result.removed} expired session tombstones`,
        ...outcome.result,
      };
    } catch (error) {
      logger.error("Session revocation prune cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
