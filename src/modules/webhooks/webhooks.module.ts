import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { WebhooksDispatchService } from "./webhooks-dispatch.service";

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksDispatchService],
  exports: [WebhooksDispatchService],
})
export class WebhooksModule {}
