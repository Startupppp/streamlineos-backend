import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { InvSalesOrdersController } from "./inv-sales-orders.controller";
import { SoCoreService } from "./so-core.service";
import { SoFulfillmentService } from "./so-fulfillment.service";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";
import { AccountingModule } from "../accounting/accounting.module";

@Module({
  imports: [BillingModule, InvStockEngineModule, AccountingModule],
  controllers: [InvSalesOrdersController],
  providers: [SoCoreService, SoFulfillmentService],
  exports: [SoCoreService, SoFulfillmentService],
})
export class InvSalesOrdersModule {}
