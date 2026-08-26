import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { BillingService } from "./billing.service";
import { RazorpayService } from "./razorpay.service";
import { PLATFORM_PAYMENT_PROVIDER } from "./platform-payment-provider";
import { MarketplaceService } from "./marketplace.service";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import { AiCreditsUsageService } from "./ai-credits-usage.service";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
import { PlanLimitsService } from "./plan-limits.service";
import { NotificationsModule } from "../../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [BillingController, RazorpayWebhookController],
  providers: [
    BillingService,
    RazorpayService,
    // The one implementation today. Ticket 02 adds a second and routes by the
    // tenant's billing country; no call site changes when it does.
    { provide: PLATFORM_PAYMENT_PROVIDER, useExisting: RazorpayService }, MarketplaceService, AiCreditsService, AiCreditsReservationService, AiCreditsPacksService, AiCreditsUsageService, AffiliateService, ReferralService, RevenueAnalyticsService, EnterpriseQuotesService, PlanLimitsService],
  exports: [AiCreditsService, AiCreditsUsageService, RevenueAnalyticsService, PlanLimitsService],
})
export class BillingModule {}
