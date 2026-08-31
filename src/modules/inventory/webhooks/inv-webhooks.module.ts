import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvWebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { InventoryWebhookEmitter } from "./webhook-emitter.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvWebhooksController],
  providers: [WebhooksService, InventoryWebhookEmitter],
  exports: [InventoryWebhookEmitter],
})
export class InvWebhooksModule {}
