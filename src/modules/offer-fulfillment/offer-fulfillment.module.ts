import { Module } from "@nestjs/common";
import { OfferFulfillmentController } from "./offer-fulfillment.controller";
import { OfferFulfillmentService } from "./offer-fulfillment.service";
import { DealClosedConsumerService } from "./deal-closed-consumer.service";
import { InvStockEngineModule } from "../inventory/stock-engine/inv-stock-engine.module";
import { OutboxModule } from "../../common/outbox/outbox.module";

@Module({
  imports: [InvStockEngineModule, OutboxModule],
  controllers: [OfferFulfillmentController],
  providers: [OfferFulfillmentService, DealClosedConsumerService],
})
export class OfferFulfillmentModule {}
