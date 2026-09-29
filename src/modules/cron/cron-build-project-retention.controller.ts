import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
  Query,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";
import { CronBuildProjectRetentionService } from "./cron-build-project-retention.service";
import { buildProjectRetentionPurgeResponseSchema } from "./dto/cron-build-response.schemas";
import {
  buildProjectRetentionPurgeQuerySchema,
  type BuildProjectRetentionPurgeQuery,
} from "./dto/cron-build.schemas";

@Public()
@Controller("cron")
export class CronBuildProjectRetentionController {
  constructor(
    private readonly buildProjectRetention: CronBuildProjectRetentionService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("build-project-retention-purge")
  @ResponseSchema(buildProjectRetentionPurgeResponseSchema)
  @Validate({ query: buildProjectRetentionPurgeQuerySchema })
  getBuildProjectRetentionPurge(
    @Query() query: BuildProjectRetentionPurgeQuery,
    @Headers("authorization") authorization?: string,
  ) {
    return this.run(query, authorization);
  }

  @Post("build-project-retention-purge")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(buildProjectRetentionPurgeResponseSchema)
  @Validate({ query: buildProjectRetentionPurgeQuerySchema })
  postBuildProjectRetentionPurge(
    @Query() query: BuildProjectRetentionPurgeQuery,
    @Headers("authorization") authorization?: string,
  ) {
    return this.run(query, authorization);
  }

  private async run(
    query: BuildProjectRetentionPurgeQuery,
    authorization?: string,
  ) {
    assertCronSecret(authorization);
    const confirm = query.confirm === "destroy";
    try {
      const outcome = await this.cronLease.withLease(
        "build-project-retention-purge",
        1800,
        () => this.buildProjectRetention.sweep({ confirm }),
      );
      if (!outcome.ran)
        return {
          success: true,
          skipped: true,
          message: "build-project-retention-purge already running",
        };
      const result = outcome.result;
      const held =
        `${result.projectsHeld} project(s) and ${result.organizationsHeld} organization(s) ` +
        `under legal hold, ${result.projectsUnconfigured} with no configured period` +
        (result.truncated ? ", run budget spent — more remain for the next run" : "");
      return {
        success: true,
        message: result.dryRun
          ? `Dry run over ${result.organizations} organization(s): would delete ` +
            `${result.ticketsWouldDelete} closed ticket(s) and ${result.attachmentsWouldDelete} ` +
            `attachment(s) across ${result.projectsPurged} project(s); ${held}. Nothing was ` +
            `deleted — pass ?confirm=destroy to purge`
          : `Purged ${result.ticketsDeleted} closed ticket(s) and ${result.attachmentsDeleted} ` +
            `attachment(s) across ${result.projectsPurged} project(s) in ` +
            `${result.organizations} organization(s); ${held}`,
        ...result,
      };
    } catch (error) {
      logger.error("Build project retention purge cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
