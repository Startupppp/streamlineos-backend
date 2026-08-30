import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller";
import { PaymentWebhooksPublicController } from "./payment-webhooks-public.controller";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";
import { PaymentWebhookHealthService } from "./payment-webhook-health.service";
import { PaymentReadinessService } from "./payment-readiness.service";
import { PaymentManualMethodsService } from "./payment-manual-methods.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import { OnboardingFlowModule } from "../../hr/onboarding/flow/onboarding-flow.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";

@Module({
  imports: [OnboardingFlowModule, NotificationsModule, AccountingAdaptersModule],
  controllers: [PaymentsController, PaymentWebhooksPublicController],
  providers: [
    PaymentProviderSetupService,
    PaymentProviderResolver,
    PaymentAuditService,
    PaymentProviderAdapterRegistry,
    RazorpayAdapter,
    PaymentTestTransactionService,
    PaymentWebhookHealthService,
    PaymentReadinessService,
    PaymentManualMethodsService,
    PaymentAnalyticsService,
  ],
  exports: [
    PaymentProviderSetupService,
    PaymentProviderResolver,
    PaymentAuditService,
    PaymentProviderAdapterRegistry,
    PaymentWebhookHealthService,
    PaymentAnalyticsService,
  ],
})
export class PaymentsModule {}
