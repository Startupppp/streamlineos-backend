import { Module } from "@nestjs/common";
import { AblyService } from "./ably.service";
import { WebPushService } from "./web-push.service";

@Module({
  providers: [AblyService, WebPushService],
  exports: [AblyService, WebPushService],
})
export class RealtimeModule {}
