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
import { StripeService } from "./stripe.service";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { NotificationsModule } from "../../notifications/notifications.module";
import { PaymentsModule } from "../payments/payments.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";

@Module({
  imports: [NotificationsModule, PaymentsModule, OutboxModule],
  controllers: [BillingController, RazorpayWebhookController],
  providers: [
    BillingService,
    RazorpayService,
    // The one implementation today. Ticket 02 adds a second and routes by the
    // tenant's billing country; no call site changes when it does.
    StripeService,
    /**
     * Razorpay stays the default injection, and the registry is how a caller
     * asks for anything else. Ticket 02 adds a provider beside Razorpay rather
     * than replacing it: India is the largest existing market.
     */
    { provide: PLATFORM_PAYMENT_PROVIDER, useExisting: RazorpayService },
    PlatformPaymentRegistry, MarketplaceService, AiCreditsService, AiCreditsReservationService, AiCreditsPacksService, AiCreditsUsageService, AffiliateService, ReferralService, RevenueAnalyticsService, EnterpriseQuotesService, PlanLimitsService],
  exports: [PlatformPaymentRegistry, AiCreditsService, AiCreditsUsageService, RevenueAnalyticsService, PlanLimitsService],
})
export class BillingModule {}
