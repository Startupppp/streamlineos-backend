import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller";
import { PaymentWebhooksPublicController } from "./payment-webhooks-public.controller";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";
import { PaymentWebhookHealthService } from "./payment-webhook-health.service";
import { PaymentReadinessService } from "./payment-readiness.service";

@Module({
  controllers: [PaymentsController, PaymentWebhooksPublicController],
  providers: [
    PaymentProviderSetupService,
    PaymentAuditService,
    PaymentProviderAdapterRegistry,
    RazorpayAdapter,
    PaymentTestTransactionService,
    PaymentWebhookHealthService,
    PaymentReadinessService,
  ],
  exports: [PaymentProviderSetupService, PaymentAuditService, PaymentProviderAdapterRegistry],
})
export class PaymentsModule {}
