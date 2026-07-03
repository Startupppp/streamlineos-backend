import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentProviderSetupService,
    PaymentAuditService,
    PaymentProviderAdapterRegistry,
    RazorpayAdapter,
    PaymentTestTransactionService,
  ],
  exports: [PaymentProviderSetupService, PaymentAuditService, PaymentProviderAdapterRegistry],
})
export class PaymentsModule {}
