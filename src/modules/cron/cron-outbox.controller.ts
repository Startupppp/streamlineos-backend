import { Controller, Get, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { OutboxPublisherService } from "../../common/outbox/outbox-publisher.service";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";

/** Platform scheduler entry point for the generic transactional outbox. */
@Public()
@Controller("cron")
export class CronOutboxController {
  constructor(
    private readonly publisher: OutboxPublisherService,
    private readonly lease: CronLeaseService,
  ) {}

  @Get("outbox-events-worker")
  runGet(@Headers("authorization") authorization?: string) {
    return this.run(authorization);
  }

  @Post("outbox-events-worker")
  @HttpCode(200)
  runPost(@Headers("authorization") authorization?: string) {
    return this.run(authorization);
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
}
