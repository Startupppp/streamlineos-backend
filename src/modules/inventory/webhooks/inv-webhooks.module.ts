import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvWebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { InventoryWebhookEmitter } from "./webhook-emitter.service";
import { InventoryOutboxConsumer } from "./inventory-outbox-consumer";
import { WebhookTransportService } from "./webhook-transport.service";
import { InventoryWebhookDeliveryWorker } from "./webhook-delivery.worker";
import { InventoryWebhookDeliveryController } from "./webhook-delivery.controller";

@Module({
  // A5. OutboxModule for the consumer registry: inventory's domain events were
  // written to the outbox and dispatched to nobody, because no consumer was
  // ever registered for them.
  // E7. NotificationsModule for the alert that must reach a human before this
  // module switches a customer's subscription off. `AccessService` — which
  // resolves who that human is — comes from the global `AccessModule`.
  imports: [InvStockEngineModule, OutboxModule, NotificationsModule],
  controllers: [InvWebhooksController, InventoryWebhookDeliveryController],
  providers: [
    WebhooksService,
    InventoryWebhookEmitter,
    InventoryOutboxConsumer,
    WebhookTransportService,
    InventoryWebhookDeliveryWorker,
  ],
  exports: [InventoryWebhookEmitter],
})
export class InvWebhooksModule {}
