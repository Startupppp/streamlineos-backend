import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { InventoryWebhookEmitter } from "./webhook-emitter.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, InventoryWebhookEmitter],
  exports: [InventoryWebhookEmitter],
})
export class InvWebhooksModule {}
