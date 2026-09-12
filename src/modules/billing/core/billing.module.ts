import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingMarketplaceController } from "./billing-marketplace.controller";
import { BillingEnterpriseController } from "./billing-enterprise.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { PlatformPromotionsController } from "./platform-promotions.controller";
import { BillingService } from "./billing.service";
import { BillingProfileService } from "./billing-profile.service";
import { MarketplaceService } from "./marketplace.service";
import { AiCreditsUsageService } from "./ai-credits-usage.service";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
import { PlanLimitsService } from "./plan-limits.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { SeatLedgerService } from "./seat-ledger.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { ProrationLedgerReportsService } from "./proration-ledger-reports.service";
import { UsageMeteringService } from "./usage-metering.service";
import { InvoiceSnapshotService } from "./invoice-snapshot.service";
import { AiCreditsModule } from "./ai-credits.module";
import { RazorpayService } from "./razorpay.service";
import { StripeService } from "./stripe.service";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { StripeWebhookLedger } from "./stripe-webhook-ledger";
import { StripePlatformWebhookService } from "./stripe-webhook.service";
import { StripeWebhookController } from "./stripe-webhook.controller";
import { PaymentsModule } from "../payments/payments.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { NotificationsModule } from "../../notifications/notifications.module";

/**
 * Platform billing — us charging a tenant for their subscription, as opposed to
 * the tenant-facing gateways behind `PaymentsModule`, which are an organisation
 * charging its own customers. The two directions share no credential.
 *
 * `PlatformPaymentRegistry` is the single place that knows which provider is
 * which, so both implementations have to be constructible beside it; naming them
 * here is what keeps every other file from having to.
 *
 * Stripe has no client-side payment signature, so its webhook is not an extra —
 * it is the only path by which a Stripe payment activates anything, and an
 * unregistered controller compiles green and does not exist at runtime.
 */
const PLATFORM_PAYMENT_PROVIDERS = [
  RazorpayService,
  StripeService,
  PlatformPaymentRegistry,
  StripeWebhookLedger,
  StripePlatformWebhookService,
];

@Module({
  imports: [AiCreditsModule, PaymentsModule, OutboxModule, NotificationsModule],
  controllers: [BillingController, BillingMarketplaceController, BillingEnterpriseController, RazorpayWebhookController, StripeWebhookController, PlatformPromotionsController],
  providers: [BillingService, BillingProfileService, MarketplaceService, AiCreditsUsageService, AffiliateService, ReferralService, RevenueAnalyticsService, EnterpriseQuotesService, PlanLimitsService, VersionedCatalogService, SeatLedgerService, ProrationLedgerService, ProrationLedgerReportsService, UsageMeteringService, InvoiceSnapshotService, ...PLATFORM_PAYMENT_PROVIDERS],
  exports: [AiCreditsModule, BillingService, AiCreditsUsageService, RevenueAnalyticsService, PlanLimitsService, VersionedCatalogService, SeatLedgerService, ProrationLedgerService, ProrationLedgerReportsService, UsageMeteringService, InvoiceSnapshotService],
})
export class BillingModule {}
