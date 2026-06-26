import { Module } from "@nestjs/common";
import { RealtimeController } from "./realtime.controller";
import { AblyService } from "./ably.service";
import { WebPushService } from "./web-push.service";

@Module({
  controllers: [RealtimeController],
  providers: [AblyService, WebPushService],
  exports: [AblyService, WebPushService],
})
export class RealtimeModule {}
