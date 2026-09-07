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
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";
import { CronGdprExportRetentionService } from "./cron-gdpr-export-retention.service";
import { gdprExportArtifactRetentionResponseSchema } from "./dto/cron-gdpr-response.schemas";

/**
 * The manual trigger for the artifact sweep. `CronRetentionSchedulerService` takes the same
 * lease on the same cadence, so this route is the operator's override rather than the only
 * way the sweep ever runs — which is what `expireOldJobs` was: shipped, correct, uncalled.
 */
@Public()
@Controller("cron")
export class CronGdprController {
  constructor(
    private readonly cronLease: CronLeaseService,
    private readonly gdprExportRetention: CronGdprExportRetentionService,
  ) {}

  @Get("gdpr-export-artifact-retention")
  @ResponseSchema(gdprExportArtifactRetentionResponseSchema)
  getGdprExportArtifactRetention(@Headers("authorization") authorization?: string) {
    return this.runGdprExportArtifactRetention(authorization);
  }

  @Post("gdpr-export-artifact-retention")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(gdprExportArtifactRetentionResponseSchema)
  postGdprExportArtifactRetention(@Headers("authorization") authorization?: string) {
    return this.runGdprExportArtifactRetention(authorization);
  }

  private async runGdprExportArtifactRetention(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease(
        "gdpr-export-artifact-retention",
        900,
        () => this.gdprExportRetention.sweep(),
      );
      if (!outcome.ran)
        return {
          success: true,
          skipped: true,
          message: "gdpr-export-artifact-retention already running",
        };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("GDPR export artifact retention cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
