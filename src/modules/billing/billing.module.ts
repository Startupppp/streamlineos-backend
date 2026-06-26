import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { BillingService } from "./billing.service";
import { RazorpayService } from "./razorpay.service";

@Module({
  controllers: [BillingController, RazorpayWebhookController],
  providers: [BillingService, RazorpayService],
})
export class BillingModule {}
