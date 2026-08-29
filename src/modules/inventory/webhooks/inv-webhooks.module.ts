import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { InventoryWebhookEmitter } from "./webhook-emitter.service";
import { InventoryOutboxConsumer } from "./inventory-outbox-consumer";

@Module({
  // A5. OutboxModule for the consumer registry: inventory's domain events were
  // written to the outbox and dispatched to nobody, because no consumer was
  // ever registered for them.
  imports: [InvStockEngineModule, OutboxModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, InventoryWebhookEmitter, InventoryOutboxConsumer],
  exports: [InventoryWebhookEmitter],
})
export class InvWebhooksModule {}
