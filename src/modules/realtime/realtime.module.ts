import { Module } from "@nestjs/common";
import { AblyService } from "./ably.service";
import { WebPushService } from "./web-push.service";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { RealtimeTokenRevocationConsumer } from "./realtime-token-revocation";

@Module({
  imports: [OutboxModule],
  providers: [AblyService, WebPushService, RealtimeTokenRevocationConsumer],
  exports: [AblyService, WebPushService],
})
export class RealtimeModule {}
