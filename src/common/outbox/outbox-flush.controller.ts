import { Controller, Headers, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { assertCronSecret } from "../../modules/cron/cron-secret";
import { OutboxPublisherService, type OutboxFlushResult } from "./outbox-publisher.service";

@Public()
@Controller("cron")
export class OutboxFlushController {
  constructor(private readonly publisher: OutboxPublisherService) {}

  @Post("outbox-events-flush")
  flush(@Headers("authorization") authorization: string | undefined): Promise<OutboxFlushResult> {
    assertCronSecret(authorization);
    return this.publisher.flush();
  }
}
