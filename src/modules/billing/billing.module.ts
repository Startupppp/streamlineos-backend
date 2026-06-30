import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { BillingService } from "./billing.service";
import { RazorpayService } from "./razorpay.service";
import { MarketplaceService } from "./marketplace.service";
import { AiCreditsService } from "./ai-credits.service";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";

@Module({
  controllers: [BillingController, RazorpayWebhookController],
  providers: [BillingService, RazorpayService, MarketplaceService, AiCreditsService, AffiliateService, ReferralService, RevenueAnalyticsService, EnterpriseQuotesService],
  exports: [AiCreditsService, RevenueAnalyticsService],
})
export class BillingModule {}
