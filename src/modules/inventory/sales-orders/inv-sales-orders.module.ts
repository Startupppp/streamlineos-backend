import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { InvSalesOrdersController } from "./inv-sales-orders.controller";
import { SoCoreService } from "./so-core.service";
import { SoLifecycleService } from "./so-lifecycle.service";
import { SoFulfillmentService } from "./so-fulfillment.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";

@Module({
  imports: [BillingModule, InvStockEngineModule, AccountingAdaptersModule],
  controllers: [InvSalesOrdersController],
  providers: [SoCoreService, SoLifecycleService, SoFulfillmentService],
  exports: [SoCoreService, SoFulfillmentService],
})
export class InvSalesOrdersModule {}
