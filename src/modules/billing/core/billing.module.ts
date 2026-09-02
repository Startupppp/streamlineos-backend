import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingMarketplaceController } from "./billing-marketplace.controller";
import { BillingEnterpriseController } from "./billing-enterprise.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
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
import { UsageMeteringService } from "./usage-metering.service";
import { InvoiceSnapshotService } from "./invoice-snapshot.service";
import { AiCreditsModule } from "./ai-credits.module";
import { PaymentsModule } from "../payments/payments.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { NotificationsModule } from "../../notifications/notifications.module";

@Module({
  imports: [AiCreditsModule, PaymentsModule, OutboxModule, NotificationsModule],
  controllers: [BillingController, BillingMarketplaceController, BillingEnterpriseController, RazorpayWebhookController],
  providers: [BillingService, BillingProfileService, MarketplaceService, AiCreditsUsageService, AffiliateService, ReferralService, RevenueAnalyticsService, EnterpriseQuotesService, PlanLimitsService, VersionedCatalogService, SeatLedgerService, ProrationLedgerService, UsageMeteringService, InvoiceSnapshotService],
  exports: [AiCreditsModule, BillingService, AiCreditsUsageService, RevenueAnalyticsService, PlanLimitsService, VersionedCatalogService, SeatLedgerService, ProrationLedgerService, UsageMeteringService, InvoiceSnapshotService],
})
export class BillingModule {}
