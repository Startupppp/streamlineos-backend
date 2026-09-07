import { Controller, Get, Headers, HttpCode, InternalServerErrorException, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { OutboxPublisherService } from "../../common/outbox/outbox-publisher.service";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";
import { CronOutboxRetentionService } from "./cron-outbox-retention.service";
import {
  outboxEventsWorkerResponseSchema,
  outboxMetricsResponseSchema,
  outboxReportResponseSchema,
  outboxEventsRetentionSweepResponseSchema,
} from "./dto/cron-outbox-response.schemas";
import { logger } from "../../common/logger/logger.service";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

/** Platform scheduler entry point for the generic transactional outbox. */
@Public()
@Controller("cron")
export class CronOutboxController {
  constructor(
    private readonly publisher: OutboxPublisherService,
    private readonly lease: CronLeaseService,
    private readonly outboxRetention: CronOutboxRetentionService,
  ) {}

  @Get("outbox-events-worker")
  @ResponseSchema(outboxEventsWorkerResponseSchema)
  runGet(@Headers("authorization") authorization?: string) {
    return this.run(authorization);
  }

  @Post("outbox-events-worker")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(outboxEventsWorkerResponseSchema)
  runPost(@Headers("authorization") authorization?: string) {
    return this.run(authorization);
  }

  @Get("outbox-events-metrics")
  @ResponseSchema(outboxMetricsResponseSchema)
  metrics(@Headers("authorization") authorization?: string) {
    assertCronSecret(authorization);
    return this.publisher.metrics();
  }

  @Get("outbox-events-report")
  @ResponseSchema(outboxReportResponseSchema)
  report(@Headers("authorization") authorization?: string) {
    assertCronSecret(authorization);
    return this.publisher.report();
  }

  @Get("outbox-events-retention-sweep")
  @ResponseSchema(outboxEventsRetentionSweepResponseSchema)
  getOutboxEventsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runOutboxEventsRetentionSweep(authorization);
  }

  @Post("outbox-events-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(outboxEventsRetentionSweepResponseSchema)
  postOutboxEventsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runOutboxEventsRetentionSweep(authorization);
  }

  private async run(authorization?: string) {
    assertCronSecret(authorization);
    const outcome = await this.lease.withLease("outbox-events-worker", 120, () =>
      this.publisher.flush(),
    );
    if (!outcome.ran) {
      return { success: true, skipped: true, message: "outbox-events-worker already running" };
    }
    return { success: true, ...outcome.result };
  }

  private async runOutboxEventsRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.lease.withLease("outbox-events-retention-sweep", 1800, () =>
        this.outboxRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "outbox-events-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `Outbox retention: ${result.outboxEventsDeleted} outbox events and ${result.inboxRecordsDeleted} inbox records deleted` +
          (result.truncated ? " (truncated — rerun)" : ""),
        ...result,
      };
    } catch (error) {
      logger.error("Outbox events retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
