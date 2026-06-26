import { Module } from "@nestjs/common";
import { InvSalesOrdersController } from "./inv-sales-orders.controller";
import { InvSalesOrdersService } from "./inv-sales-orders.service";
import { AccountingModule } from "../accounting/accounting.module";

@Module({
  imports: [AccountingModule],
  controllers: [InvSalesOrdersController],
  providers: [InvSalesOrdersService],
  exports: [InvSalesOrdersService],
})
export class InvSalesOrdersModule {}
