import { Module } from "@nestjs/common";
import { BillingModule } from "./core/billing.module";
import { PaymentsModule } from "./payments/payments.module";

const BILLING_MODULES = [BillingModule, PaymentsModule];

@Module({
  imports: BILLING_MODULES,
  exports: BILLING_MODULES,
})
export class BillingRootModule {}
