import { Module } from "@nestjs/common";
import { InvPurchaseOrdersController } from "./inv-purchase-orders.controller";
import { InvPurchaseOrdersService } from "./inv-purchase-orders.service";
import { AccountingModule } from "../accounting/accounting.module";

@Module({
  imports: [AccountingModule],
  controllers: [InvPurchaseOrdersController],
  providers: [InvPurchaseOrdersService],
  exports: [InvPurchaseOrdersService],
})
export class InvPurchaseOrdersModule {}
