import { Module } from "@nestjs/common";
import { OfferFulfillmentController } from "./offer-fulfillment.controller";
import { OfferFulfillmentService } from "./offer-fulfillment.service";

@Module({
  controllers: [OfferFulfillmentController],
  providers: [OfferFulfillmentService],
  exports: [OfferFulfillmentService],
})
export class OfferFulfillmentModule {}
