import { Module } from "@nestjs/common";
import { AblyService } from "./ably.service";
import { WebPushService } from "./web-push.service";
import { RealtimeController } from "./realtime.controller";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { RealtimeTokenRevocationConsumer } from "./realtime-token-revocation";

@Module({
  imports: [OutboxModule],
  controllers: [RealtimeController],
  providers: [AblyService, WebPushService, RealtimeTokenRevocationConsumer],
  exports: [AblyService, WebPushService],
})
export class RealtimeModule {}
