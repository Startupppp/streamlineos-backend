import { Module } from "@nestjs/common";
import { AblyService } from "./ably.service";
import { WebPushService } from "./web-push.service";
import { RealtimeController } from "./realtime.controller";

@Module({
  controllers: [RealtimeController],
  providers: [AblyService, WebPushService],
  exports: [AblyService, WebPushService],
})
export class RealtimeModule {}
