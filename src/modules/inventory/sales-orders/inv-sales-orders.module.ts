import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { InvSalesOrdersController } from "./inv-sales-orders.controller";
import { SoCoreService } from "./so-core.service";
import { SoLifecycleService } from "./so-lifecycle.service";
import { SoFulfillmentService } from "./so-fulfillment.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { InvComplianceModule } from "../compliance/inv-compliance.module";

/**
 * E5 — `InvComplianceModule` is imported so `SoFulfillmentService` can reach
 * `IndiaComplianceService` after a shipment posts. Without it the compliance
 * boundary is a well-built contract with no caller, which is what it was: the
 * flags existed, the adapter existed, the tables existed, and nothing in the
 * product ever asked for a document.
 */
@Module({
  imports: [BillingModule, InvStockEngineModule, AccountingAdaptersModule, InvComplianceModule],
  controllers: [InvSalesOrdersController],
  providers: [SoCoreService, SoLifecycleService, SoFulfillmentService],
  exports: [SoCoreService, SoFulfillmentService],
})
export class InvSalesOrdersModule {}
