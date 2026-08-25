import { Controller, Get, Headers, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { assertCronSecret } from "../../modules/cron/cron-secret";
import { OutboxPublisherService, type OutboxFlushResult } from "./outbox-publisher.service";

/** Legacy scheduler endpoint retained for source compatibility; CronModule owns the active worker route. */
@Public()
@Controller("cron")
export class OutboxFlushController {
  constructor(private readonly publisher: OutboxPublisherService) {}

  @Post("outbox-events-flush")
  flush(@Headers("authorization") authorization: string | undefined): Promise<OutboxFlushResult> {
    assertCronSecret(authorization);
    return this.publisher.flush();
  }

  @Get("outbox-events-metrics")
  metrics(@Headers("authorization") authorization: string | undefined) {
    assertCronSecret(authorization);
    return this.publisher.metrics();
  }
}
