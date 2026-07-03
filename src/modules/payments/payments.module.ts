import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";

@Module({
  controllers: [PaymentsController],
  providers: [PaymentProviderSetupService, PaymentAuditService, PaymentProviderAdapterRegistry],
  exports: [PaymentProviderSetupService, PaymentAuditService, PaymentProviderAdapterRegistry],
})
export class PaymentsModule {}
