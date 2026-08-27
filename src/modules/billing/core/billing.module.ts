import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { BillingService } from "./billing.service";
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
import { VersionedCatalogService } from "./versioned-catalog.service";
import { SeatLedgerService } from "./seat-ledger.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { NotificationsModule } from "../../notifications/notifications.module";
import { PaymentsModule } from "../payments/payments.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";

@Module({
  imports: [NotificationsModule, PaymentsModule, OutboxModule],
  controllers: [BillingController, RazorpayWebhookController],
  providers: [BillingService, MarketplaceService, AiCreditsService, AiCreditsReservationService, AiCreditsPacksService, AiCreditsUsageService, AffiliateService, ReferralService, RevenueAnalyticsService, EnterpriseQuotesService, PlanLimitsService, VersionedCatalogService, SeatLedgerService, ProrationLedgerService],
  exports: [AiCreditsService, AiCreditsUsageService, RevenueAnalyticsService, PlanLimitsService, VersionedCatalogService, SeatLedgerService, ProrationLedgerService],
})
export class BillingModule {}
